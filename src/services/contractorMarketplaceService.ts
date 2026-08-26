/**
 * Contractor Marketplace Service
 * API interactions for the contractor marketplace system
 */

import type {
  Contractor,
  MarketplaceListing,
  MarketplaceBid,
  BidAnalytics,
  ContractorAIOverview,
  ContractorDashboardData,
  OwnerMarketplaceData,
  CreateListingRequest,
  SubmitBidRequest
} from '../types/contractorMarketplace';

const getApiUrl = (path: string): string => {
  const baseEnv = (import.meta as any).env?.VITE_PUSH_SERVER_URL;
  const useProxy = import.meta.env.MODE === 'development' && !baseEnv;
  return useProxy ? path : `${baseEnv || 'http://127.0.0.1:3001'}${path}`;
};

// ============================================================================
// Contractor Profile Management
// ============================================================================

export async function getContractorProfile(contractorId: string): Promise<{
  success: boolean;
  contractor?: Contractor;
  error?: string;
}> {
  try {
    const response = await fetch(getApiUrl(`/api/marketplace/contractors/${contractorId}`));
    const data = await response.json();
    return data;
  } catch (error: any) {
    console.error('[MarketplaceService] getContractorProfile error:', error);
    return { success: false, error: error.message };
  }
}

export async function updateContractorProfile(
  contractorId: string,
  updates: Partial<Contractor>
): Promise<{ success: boolean; contractor?: Contractor; error?: string }> {
  try {
    const response = await fetch(getApiUrl(`/api/marketplace/contractors/${contractorId}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    });
    return await response.json();
  } catch (error: any) {
    console.error('[MarketplaceService] updateContractorProfile error:', error);
    return { success: false, error: error.message };
  }
}

export async function registerContractor(
  contractorData: Omit<Contractor, 'id' | 'createdAt' | 'updatedAt'>
): Promise<{ success: boolean; contractor?: Contractor; error?: string }> {
  try {
    const response = await fetch(getApiUrl('/api/marketplace/contractors/register'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(contractorData)
    });
    return await response.json();
  } catch (error: any) {
    console.error('[MarketplaceService] registerContractor error:', error);
    return { success: false, error: error.message };
  }
}

// ============================================================================
// Marketplace Listings
// ============================================================================

export async function getActiveListings(filters?: {
  renovationType?: string;
  location?: { lat: number; lng: number; radiusMiles: number };
  minBudget?: number;
  maxBudget?: number;
}): Promise<{ success: boolean; listings?: MarketplaceListing[]; error?: string }> {
  try {
    const params = new URLSearchParams();
    if (filters?.renovationType) params.set('type', filters.renovationType);
    if (filters?.minBudget) params.set('minBudget', String(filters.minBudget));
    if (filters?.maxBudget) params.set('maxBudget', String(filters.maxBudget));
    if (filters?.location) {
      params.set('lat', String(filters.location.lat));
      params.set('lng', String(filters.location.lng));
      params.set('radius', String(filters.location.radiusMiles));
    }

    const response = await fetch(getApiUrl(`/api/marketplace/listings?${params.toString()}`));
    const data = await response.json();
    return data;
  } catch (error: any) {
    console.error('[MarketplaceService] getActiveListings error:', error);
    return { success: false, error: error.message };
  }
}

export async function getListingDetails(listingId: string): Promise<{
  success: boolean;
  listing?: MarketplaceListing;
  error?: string;
}> {
  try {
    const response = await fetch(getApiUrl(`/api/marketplace/listings/${listingId}`));
    return await response.json();
  } catch (error: any) {
    console.error('[MarketplaceService] getListingDetails error:', error);
    return { success: false, error: error.message };
  }
}

export async function createListing(
  request: CreateListingRequest
): Promise<{ success: boolean; listing?: MarketplaceListing; error?: string }> {
  try {
    const response = await fetch(getApiUrl('/api/marketplace/listings'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request)
    });
    return await response.json();
  } catch (error: any) {
    console.error('[MarketplaceService] createListing error:', error);
    return { success: false, error: error.message };
  }
}

export async function updateListingStatus(
  listingId: string,
  status: MarketplaceListing['status']
): Promise<{ success: boolean; listing?: MarketplaceListing; error?: string }> {
  try {
    const response = await fetch(getApiUrl(`/api/marketplace/listings/${listingId}/status`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });
    return await response.json();
  } catch (error: any) {
    console.error('[MarketplaceService] updateListingStatus error:', error);
    return { success: false, error: error.message };
  }
}

export async function deleteListing(listingId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(getApiUrl(`/api/marketplace/listings/${listingId}`), {
      method: 'DELETE'
    });
    return await response.json();
  } catch (error: any) {
    console.error('[MarketplaceService] deleteListing error:', error);
    return { success: false, error: error.message };
  }
}

// ============================================================================
// Bidding
// ============================================================================

export async function submitBid(
  request: SubmitBidRequest
): Promise<{ success: boolean; bid?: MarketplaceBid; error?: string }> {
  try {
    const response = await fetch(getApiUrl('/api/marketplace/bids'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request)
    });
    return await response.json();
  } catch (error: any) {
    console.error('[MarketplaceService] submitBid error:', error);
    return { success: false, error: error.message };
  }
}

export async function updateBid(
  bidId: string,
  updates: Partial<SubmitBidRequest>
): Promise<{ success: boolean; bid?: MarketplaceBid; error?: string }> {
  try {
    const response = await fetch(getApiUrl(`/api/marketplace/bids/${bidId}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    });
    return await response.json();
  } catch (error: any) {
    console.error('[MarketplaceService] updateBid error:', error);
    return { success: false, error: error.message };
  }
}

export async function withdrawBid(bidId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(getApiUrl(`/api/marketplace/bids/${bidId}/withdraw`), {
      method: 'POST'
    });
    return await response.json();
  } catch (error: any) {
    console.error('[MarketplaceService] withdrawBid error:', error);
    return { success: false, error: error.message };
  }
}

export async function acceptBid(bidId: string): Promise<{ success: boolean; bid?: MarketplaceBid; error?: string }> {
  try {
    const response = await fetch(getApiUrl(`/api/marketplace/bids/${bidId}/accept`), {
      method: 'POST'
    });
    return await response.json();
  } catch (error: any) {
    console.error('[MarketplaceService] acceptBid error:', error);
    return { success: false, error: error.message };
  }
}

export async function rejectBid(bidId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(getApiUrl(`/api/marketplace/bids/${bidId}/reject`), {
      method: 'POST'
    });
    return await response.json();
  } catch (error: any) {
    console.error('[MarketplaceService] rejectBid error:', error);
    return { success: false, error: error.message };
  }
}

// ============================================================================
// Analytics & AI
// ============================================================================

export async function getBidAnalytics(listingId: string): Promise<{
  success: boolean;
  analytics?: BidAnalytics;
  error?: string;
}> {
  try {
    const response = await fetch(getApiUrl(`/api/marketplace/listings/${listingId}/analytics`));
    return await response.json();
  } catch (error: any) {
    console.error('[MarketplaceService] getBidAnalytics error:', error);
    return { success: false, error: error.message };
  }
}

export async function getContractorAIOverview(contractorId: string): Promise<{
  success: boolean;
  overview?: ContractorAIOverview;
  error?: string;
}> {
  try {
    const response = await fetch(getApiUrl(`/api/marketplace/contractors/${contractorId}/ai-overview`));
    return await response.json();
  } catch (error: any) {
    console.error('[MarketplaceService] getContractorAIOverview error:', error);
    return { success: false, error: error.message };
  }
}

// ============================================================================
// Dashboard Data
// ============================================================================

export async function getContractorDashboard(): Promise<{
  success: boolean;
  data?: ContractorDashboardData;
  error?: string;
}> {
  try {
    const response = await fetch(getApiUrl('/api/marketplace/contractor/dashboard'));
    return await response.json();
  } catch (error: any) {
    console.error('[MarketplaceService] getContractorDashboard error:', error);
    return { success: false, error: error.message };
  }
}

export async function getOwnerMarketplaceData(): Promise<{
  success: boolean;
  data?: OwnerMarketplaceData;
  error?: string;
}> {
  try {
    const response = await fetch(getApiUrl('/api/marketplace/owner/dashboard'));
    return await response.json();
  } catch (error: any) {
    console.error('[MarketplaceService] getOwnerMarketplaceData error:', error);
    return { success: false, error: error.message };
  }
}

// ============================================================================
// Mock Data for Development (remove in production)
// ============================================================================

export function getMockContractors(): Contractor[] {
  return [
    {
      id: 'contractor-1',
      companyName: 'Elite Home Renovations',
      email: 'contact@elitehomereno.com',
      phone: '(301) 555-0101',
      website: 'https://elitehomereno.com',
      logoUrl: 'https://via.placeholder.com/100x100?text=EHR',
      description: 'Award-winning renovation company specializing in kitchen and bathroom remodels. Serving Maryland and DC for over 15 years.',
      specialties: ['Kitchen Remodeling', 'Bathroom Renovation', 'Flooring', 'Painting'],
      yearsInBusiness: 15,
      licenseNumber: 'MD-HIC-12345',
      insuranceVerified: true,
      location: {
        city: 'Bethesda',
        state: 'MD',
        zipCode: '20814',
        serviceRadius: 50
      },
      rating: {
        overall: 4.8,
        qualityOfWork: 4.9,
        communication: 4.7,
        punctuality: 4.6,
        value: 4.8,
        totalReviews: 127
      },
      credentials: {
        backgroundChecked: true,
        licensedAndInsured: true,
        bondedAmount: 500000,
        certifications: ['NARI Certified', 'EPA Lead-Safe Certified', 'NAHB Graduate Master Builder']
      },
      createdAt: '2020-03-15T10:00:00Z',
      updatedAt: '2024-12-01T14:30:00Z'
    },
    {
      id: 'contractor-2',
      companyName: 'Capital City Builders',
      email: 'info@capitalcitybuilders.com',
      phone: '(202) 555-0202',
      website: 'https://capitalcitybuilders.com',
      logoUrl: 'https://via.placeholder.com/100x100?text=CCB',
      description: 'Full-service construction and renovation company. From minor repairs to complete home transformations.',
      specialties: ['General Contracting', 'Room Additions', 'Basement Finishing', 'Deck Building'],
      yearsInBusiness: 22,
      licenseNumber: 'DC-CON-67890',
      insuranceVerified: true,
      location: {
        city: 'Washington',
        state: 'DC',
        zipCode: '20001',
        serviceRadius: 40
      },
      rating: {
        overall: 4.5,
        qualityOfWork: 4.6,
        communication: 4.4,
        punctuality: 4.3,
        value: 4.5,
        totalReviews: 89
      },
      credentials: {
        backgroundChecked: true,
        licensedAndInsured: true,
        bondedAmount: 1000000,
        certifications: ['CGR - Certified Graduate Remodeler', 'Green Building Professional']
      },
      createdAt: '2018-06-20T09:00:00Z',
      updatedAt: '2024-11-28T11:15:00Z'
    },
    {
      id: 'contractor-3',
      companyName: 'Budget Friendly Renos',
      email: 'hello@budgetfriendly.com',
      phone: '(703) 555-0303',
      website: 'https://budgetfriendlyrenos.com',
      logoUrl: 'https://via.placeholder.com/100x100?text=BFR',
      description: 'Quality renovations at affordable prices. We work with every budget to transform your space.',
      specialties: ['Painting', 'Flooring', 'Minor Repairs', 'Cabinet Refacing'],
      yearsInBusiness: 8,
      licenseNumber: 'VA-HIC-11111',
      insuranceVerified: true,
      location: {
        city: 'Arlington',
        state: 'VA',
        zipCode: '22201',
        serviceRadius: 30
      },
      rating: {
        overall: 4.2,
        qualityOfWork: 4.3,
        communication: 4.1,
        punctuality: 4.2,
        value: 4.8,
        totalReviews: 56
      },
      credentials: {
        backgroundChecked: true,
        licensedAndInsured: true,
        bondedAmount: 250000,
        certifications: ['EPA Lead-Safe Certified']
      },
      createdAt: '2021-09-10T08:00:00Z',
      updatedAt: '2024-12-15T16:45:00Z'
    }
  ];
}

export function getMockListings(): MarketplaceListing[] {
  const contractors = getMockContractors();
  
  return [
    {
      id: 'listing-1',
      propertyOwnerId: 'owner-1',
      propertyAddress: '123 Maple Street, Potomac, MD 20854',
      scanId: 'scan-abc123',
      scanThumbnailUrl: 'https://via.placeholder.com/400x300?text=Kitchen+Scan',
      renovationType: 'Kitchen Remodel',
      renovationDescription: 'Complete kitchen renovation including new cabinets, countertops, flooring, and appliances. Looking to modernize a 1990s kitchen with contemporary finishes.',
      estimatedCostRange: { low: 25000, high: 45000 },
      desiredStartDate: '2025-02-01',
      flexibleTimeline: true,
      roomDimensions: {
        widthFeet: 15,
        lengthFeet: 20,
        heightFeet: 9,
        floorAreaSqFt: 300
      },
      highlightedAreas: [
        { id: 'area-1', description: 'Replace outdated cabinets' },
        { id: 'area-2', description: 'Install quartz countertops' },
        { id: 'area-3', description: 'New tile flooring' }
      ],
      status: 'active',
      bids: [
        {
          id: 'bid-1',
          listingId: 'listing-1',
          contractorId: 'contractor-1',
          contractor: contractors[0],
          bidAmount: 38500,
          estimatedDuration: '4-5 weeks',
          proposedStartDate: '2025-02-10',
          scope: 'Full kitchen renovation including demo, new cabinets, quartz counters, LVP flooring, backsplash, and appliance installation.',
          materials: [
            { item: 'Cabinets (Shaker Style)', cost: 12000 },
            { item: 'Quartz Countertops', cost: 6500 },
            { item: 'LVP Flooring', cost: 2800 },
            { item: 'Tile Backsplash', cost: 1500 }
          ],
          laborCost: 15700,
          warranty: '5-year workmanship warranty',
          notes: 'Price includes all permits and inspections. We can work with your appliance selections.',
          status: 'pending',
          createdAt: '2024-12-20T10:00:00Z',
          updatedAt: '2024-12-20T10:00:00Z'
        },
        {
          id: 'bid-2',
          listingId: 'listing-1',
          contractorId: 'contractor-2',
          contractor: contractors[1],
          bidAmount: 42000,
          estimatedDuration: '3-4 weeks',
          proposedStartDate: '2025-02-05',
          scope: 'Premium kitchen remodel with custom cabinetry and premium finishes.',
          materials: [
            { item: 'Custom Cabinets', cost: 15000 },
            { item: 'Quartz Countertops (Premium)', cost: 8000 },
            { item: 'Hardwood Flooring', cost: 4000 },
            { item: 'Designer Backsplash', cost: 2500 }
          ],
          laborCost: 12500,
          warranty: '10-year workmanship warranty',
          notes: 'We use only premium materials and can expedite the project.',
          status: 'pending',
          createdAt: '2024-12-21T14:30:00Z',
          updatedAt: '2024-12-21T14:30:00Z'
        },
        {
          id: 'bid-3',
          listingId: 'listing-1',
          contractorId: 'contractor-3',
          contractor: contractors[2],
          bidAmount: 28000,
          estimatedDuration: '5-6 weeks',
          proposedStartDate: '2025-02-15',
          scope: 'Budget-friendly kitchen update with quality materials at competitive prices.',
          materials: [
            { item: 'Stock Cabinets (Quality Brand)', cost: 8000 },
            { item: 'Laminate Countertops', cost: 2500 },
            { item: 'LVP Flooring', cost: 2000 },
            { item: 'Subway Tile Backsplash', cost: 1000 }
          ],
          laborCost: 14500,
          warranty: '2-year workmanship warranty',
          notes: 'Great value option without compromising on quality workmanship.',
          status: 'pending',
          createdAt: '2024-12-22T09:15:00Z',
          updatedAt: '2024-12-22T09:15:00Z'
        }
      ],
      createdAt: '2024-12-18T08:00:00Z',
      updatedAt: '2024-12-22T09:15:00Z'
    },
    {
      id: 'listing-2',
      propertyOwnerId: 'owner-1',
      propertyAddress: '456 Oak Avenue, Rockville, MD 20852',
      scanId: 'scan-def456',
      scanThumbnailUrl: 'https://via.placeholder.com/400x300?text=Bathroom+Scan',
      renovationType: 'Bathroom Renovation',
      renovationDescription: 'Master bathroom remodel. Looking to update fixtures, install walk-in shower, and add modern vanity.',
      estimatedCostRange: { low: 15000, high: 25000 },
      desiredStartDate: '2025-03-01',
      flexibleTimeline: false,
      roomDimensions: {
        widthFeet: 8,
        lengthFeet: 10,
        heightFeet: 9,
        floorAreaSqFt: 80
      },
      highlightedAreas: [
        { id: 'area-1', description: 'Remove tub, install walk-in shower' },
        { id: 'area-2', description: 'New double vanity' }
      ],
      status: 'active',
      bids: [
        {
          id: 'bid-4',
          listingId: 'listing-2',
          contractorId: 'contractor-1',
          contractor: contractors[0],
          bidAmount: 22500,
          estimatedDuration: '2-3 weeks',
          scope: 'Complete master bath renovation with walk-in shower and modern finishes.',
          warranty: '5-year warranty',
          status: 'pending',
          createdAt: '2024-12-19T11:00:00Z',
          updatedAt: '2024-12-19T11:00:00Z'
        }
      ],
      createdAt: '2024-12-17T12:00:00Z',
      updatedAt: '2024-12-19T11:00:00Z'
    }
  ];
}

export function calculateBidAnalytics(listing: MarketplaceListing): BidAnalytics | null {
  const bids = listing.bids.filter(b => b.status === 'pending' || b.status === 'accepted');
  
  if (bids.length === 0) return null;
  
  const sortedBids = [...bids].sort((a, b) => a.bidAmount - b.bidAmount);
  const bidAmounts = sortedBids.map(b => b.bidAmount);
  
  const lowBid = sortedBids[0];
  const highBid = sortedBids[sortedBids.length - 1];
  
  // Calculate median
  const midIndex = Math.floor(sortedBids.length / 2);
  let medianBids: MarketplaceBid[];
  let medianAmount: number;
  
  if (sortedBids.length % 2 === 0) {
    medianAmount = (bidAmounts[midIndex - 1] + bidAmounts[midIndex]) / 2;
    medianBids = [sortedBids[midIndex - 1], sortedBids[midIndex]];
  } else {
    medianAmount = bidAmounts[midIndex];
    medianBids = [sortedBids[midIndex]];
  }
  
  const average = bidAmounts.reduce((sum, a) => sum + a, 0) / bidAmounts.length;
  const spread = highBid.bidAmount - lowBid.bidAmount;
  
  return {
    listingId: listing.id,
    totalBids: bids.length,
    highBid: { amount: highBid.bidAmount, bid: highBid },
    lowBid: { amount: lowBid.bidAmount, bid: lowBid },
    medianBid: { amount: medianAmount, bids: medianBids },
    averageBid: average,
    bidRange: {
      low: lowBid.bidAmount,
      high: highBid.bidAmount,
      spread,
      spreadPercent: (spread / average) * 100
    }
  };
}
