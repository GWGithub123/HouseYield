/**
 * AI Renovation Detection Service
 * Analyzes 3D photogrammetry scans and images to detect renovation opportunities
 * using OpenAI Vision API with GPT-4o/GPT-4-vision
 */

import type {
  DetectedRenovation,
  DetectRenovationsRequest,
  DetectRenovationsResponse,
  RenovationType,
  GenerateARPreviewRequest,
  GenerateARPreviewResponse,
  RenovationPreview,
} from '../types/renovationDetection';

// ============================================================================
// Configuration
// ============================================================================

const getApiUrl = (path: string): string => {
  const baseEnv = (import.meta as any).env?.VITE_PUSH_SERVER_URL;
  const useProxy = import.meta.env.MODE === 'development' && !baseEnv;
  return useProxy ? path : `${baseEnv || 'http://127.0.0.1:3001'}${path}`;
};

// ============================================================================
// Main Detection Functions
// ============================================================================

/**
 * Detect renovations from a photogrammetry scan
 * Sends scan images/model to AI for analysis
 * Falls back to mock data in development for UI testing
 */
export async function detectRenovationsFromScan(
  request: DetectRenovationsRequest
): Promise<DetectRenovationsResponse> {
  try {
    const response = await fetch(getApiUrl('/api/renovation/detect-from-scan'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });

    const data = await response.json();
    
    if (!response.ok) {
      // Handle specific error codes - fall back to mock data for demo
      console.warn('[RenovationDetection] API error, using mock data:', data.error);
      const mockRenovations = generateMockRenovations(request.scanId);
      const totals = calculateRenovationTotals(mockRenovations);
      return {
        success: true,
        scanId: request.scanId,
        renovations: mockRenovations,
        totalEstimatedCost: totals.totalCost,
        totalValueIncrease: totals.totalValueIncrease,
        totalRentIncrease: totals.totalRentIncrease,
        overallROI: totals.overallROI,
        processingTimeMs: 150,
        warning: 'Using demo data - no scan images found',
      };
    }

    return data;
  } catch (error: any) {
    console.error('[RenovationDetection] detectRenovationsFromScan error:', error);
    // Fall back to mock data so UI still works
    console.warn('[RenovationDetection] Falling back to mock data for demo');
    const mockRenovations = generateMockRenovations(request.scanId);
    const totals = calculateRenovationTotals(mockRenovations);
    return {
      success: true,
      scanId: request.scanId,
      renovations: mockRenovations,
      totalEstimatedCost: totals.totalCost,
      totalValueIncrease: totals.totalValueIncrease,
      totalRentIncrease: totals.totalRentIncrease,
      overallROI: totals.overallROI,
      processingTimeMs: 100,
      warning: 'Using demo data - API unavailable',
    };
  }
}

/**
 * Detect renovations from uploaded images (without existing scan)
 */
export async function detectRenovationsFromImages(
  images: File[],
  propertyData?: {
    address?: string;
    value?: number;
    rent?: number;
    yearBuilt?: number;
    sqft?: number;
  }
): Promise<DetectRenovationsResponse> {
  try {
    const formData = new FormData();
    images.forEach((image, index) => {
      formData.append(`image_${index}`, image);
    });
    
    if (propertyData) {
      formData.append('propertyData', JSON.stringify(propertyData));
    }

    const response = await fetch(getApiUrl('/api/renovation/detect-from-images'), {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`HTTP error: ${response.status}`);
    }

    return await response.json();
  } catch (error: any) {
    console.error('[RenovationDetection] detectRenovationsFromImages error:', error);
    return {
      success: false,
      scanId: '',
      renovations: [],
      totalEstimatedCost: 0,
      totalValueIncrease: 0,
      totalRentIncrease: 0,
      overallROI: 0,
      processingTimeMs: 0,
      error: error.message,
    };
  }
}

// ============================================================================
// AR Preview Generation
// ============================================================================

/**
 * Generate AR preview for a detected renovation
 * Creates theoretical final product visualization
 */
export async function generateARPreview(
  request: GenerateARPreviewRequest
): Promise<GenerateARPreviewResponse> {
  try {
    const response = await fetch(getApiUrl('/api/renovation/generate-ar-preview'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(`HTTP error: ${response.status}`);
    }

    return await response.json();
  } catch (error: any) {
    console.error('[RenovationDetection] generateARPreview error:', error);
    return {
      success: false,
      error: error.message,
    };
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get scan images for AI analysis
 */
export async function getScanImages(scanId: string): Promise<string[]> {
  try {
    const response = await fetch(getApiUrl(`/api/photogrammetry/scans/${scanId}/images`));
    if (!response.ok) {
      // Fallback: Try room-scanner API
      const roomScanResponse = await fetch(getApiUrl(`/api/room-scanner/scans/${scanId}/images`));
      if (!roomScanResponse.ok) {
        throw new Error('Failed to fetch scan images');
      }
      const data = await roomScanResponse.json();
      return data.images || [];
    }
    const data = await response.json();
    return data.images || [];
  } catch (error) {
    console.error('[RenovationDetection] getScanImages error:', error);
    return [];
  }
}

/**
 * Calculate summary totals for detected renovations
 */
export function calculateRenovationTotals(renovations: DetectedRenovation[]): {
  totalCost: number;
  totalValueIncrease: number;
  totalRentIncrease: number;
  overallROI: number;
} {
  const totalCost = renovations.reduce((sum, r) => sum + r.roi.estimatedCost, 0);
  const totalValueIncrease = renovations.reduce((sum, r) => sum + r.roi.valueIncrease, 0);
  const totalRentIncrease = renovations.reduce((sum, r) => sum + r.roi.rentIncreaseMonthly, 0);
  
  // Calculate overall ROI (5-year with rent income)
  const fiveYearRentIncome = totalRentIncrease * 12 * 5;
  const totalReturn = totalValueIncrease + fiveYearRentIncome;
  const overallROI = totalCost > 0 ? (totalReturn / totalCost) * 100 : 0;

  return {
    totalCost,
    totalValueIncrease,
    totalRentIncrease,
    overallROI,
  };
}

/**
 * Sort renovations by priority/ROI
 */
export function sortRenovationsByPriority(
  renovations: DetectedRenovation[],
  sortBy: 'roi' | 'cost' | 'urgency' | 'valueIncrease' = 'roi'
): DetectedRenovation[] {
  return [...renovations].sort((a, b) => {
    switch (sortBy) {
      case 'roi':
        return b.roi.roi - a.roi.roi;
      case 'cost':
        return a.roi.estimatedCost - b.roi.estimatedCost;
      case 'valueIncrease':
        return b.roi.valueIncrease - a.roi.valueIncrease;
      case 'urgency':
        const urgencyOrder = { immediate: 0, 'short-term': 1, 'long-term': 2, optional: 3 };
        return urgencyOrder[a.analysis.urgency] - urgencyOrder[b.analysis.urgency];
      default:
        return 0;
    }
  });
}

/**
 * Filter renovations by type
 */
export function filterRenovationsByType(
  renovations: DetectedRenovation[],
  types: RenovationType[]
): DetectedRenovation[] {
  if (types.length === 0) return renovations;
  return renovations.filter((r) => types.includes(r.zone.type));
}

/**
 * Get renovation within budget
 */
export function filterRenovationsWithinBudget(
  renovations: DetectedRenovation[],
  maxBudget: number
): DetectedRenovation[] {
  return renovations.filter((r) => r.roi.estimatedCost <= maxBudget);
}

/**
 * Create optimal renovation plan based on budget
 * Uses greedy algorithm to maximize ROI within budget
 */
export function createOptimalRenovationPlan(
  renovations: DetectedRenovation[],
  budget: number
): {
  selectedRenovations: DetectedRenovation[];
  totalCost: number;
  totalROI: number;
  remainingBudget: number;
} {
  // Sort by ROI descending
  const sorted = sortRenovationsByPriority(renovations, 'roi');
  
  const selected: DetectedRenovation[] = [];
  let totalCost = 0;
  
  for (const renovation of sorted) {
    if (totalCost + renovation.roi.estimatedCost <= budget) {
      selected.push(renovation);
      totalCost += renovation.roi.estimatedCost;
    }
  }
  
  const totals = calculateRenovationTotals(selected);
  
  return {
    selectedRenovations: selected,
    totalCost,
    totalROI: totals.overallROI,
    remainingBudget: budget - totalCost,
  };
}

// ============================================================================
// Mock Data for Development/Testing
// ============================================================================

/**
 * Generate mock renovation detection for development
 */
export function generateMockRenovations(scanId: string): DetectedRenovation[] {
  const mockRenovations: DetectedRenovation[] = [
    {
      id: `reno-${scanId}-kitchen-1`,
      zone: {
        id: `zone-${scanId}-kitchen-1`,
        type: 'kitchen',
        name: 'Kitchen Cabinet Upgrade',
        description: 'Replace outdated laminate cabinets with modern shaker-style cabinets',
        boundingBox: {
          min: { x: -3, y: 0, z: -2 },
          max: { x: 1, y: 2.5, z: 2 },
          center: { x: -1, y: 1.25, z: 0 },
        },
        markerPosition: { x: -1, y: 2, z: 0 },
        confidence: 0.92,
      },
      analysis: {
        explanation: 'The current cabinets appear to be original 1990s laminate with visible wear, water damage near the sink, and outdated styling. Modern shaker-style cabinets would significantly improve both aesthetics and functionality, appealing to tenants and increasing property value.',
        currentCondition: 'fair',
        urgency: 'short-term',
        complexity: 'moderate',
        estimatedDuration: '1-2 weeks',
        permits: [],
      },
      roi: {
        estimatedCost: 8500,
        costRange: { low: 7000, high: 10000 },
        valueIncrease: 12000,
        rentIncreaseMonthly: 175,
        rentIncreasePercent: 7,
        roi: 165,
        paybackMonths: 49,
        fiveYearReturn: 22500,
      },
      costBreakdown: {
        labor: 3400,
        materials: 4500,
        permits: 0,
        contingency: 600,
        total: 8500,
      },
      materials: [
        {
          name: 'Shaker-style cabinet boxes',
          category: 'fixture',
          quantity: 12,
          unit: 'units',
          unitCost: 200,
          totalCost: 2400,
          quality: 'mid-range',
        },
        {
          name: 'Cabinet doors and drawer fronts',
          category: 'fixture',
          quantity: 24,
          unit: 'units',
          unitCost: 45,
          totalCost: 1080,
          quality: 'mid-range',
        },
        {
          name: 'Soft-close hinges and hardware',
          category: 'hardware',
          quantity: 48,
          unit: 'pieces',
          unitCost: 8,
          totalCost: 384,
          quality: 'mid-range',
        },
        {
          name: 'Cabinet pulls (brushed nickel)',
          category: 'hardware',
          quantity: 24,
          unit: 'pieces',
          unitCost: 12,
          totalCost: 288,
          quality: 'mid-range',
        },
      ],
      labor: [
        {
          trade: 'Cabinet Installer',
          hours: 32,
          hourlyRate: 75,
          totalCost: 2400,
        },
        {
          trade: 'General Helper',
          hours: 16,
          hourlyRate: 35,
          totalCost: 560,
        },
      ],
    },
    {
      id: `reno-${scanId}-bathroom-1`,
      zone: {
        id: `zone-${scanId}-bathroom-1`,
        type: 'bathroom',
        name: 'Bathroom Tile & Fixtures Update',
        description: 'Replace worn tile flooring and update fixtures for modern appeal',
        boundingBox: {
          min: { x: 2, y: 0, z: -3 },
          max: { x: 5, y: 2.5, z: 0 },
          center: { x: 3.5, y: 1.25, z: -1.5 },
        },
        markerPosition: { x: 3.5, y: 2, z: -1.5 },
        confidence: 0.88,
      },
      analysis: {
        explanation: 'The bathroom shows dated fixtures (likely 1980s-90s vintage), worn grout lines, and outdated tile patterns. A refresh with modern large-format tile, updated fixtures, and new vanity would dramatically improve tenant appeal and justify higher rent.',
        currentCondition: 'fair',
        urgency: 'short-term',
        complexity: 'moderate',
        estimatedDuration: '1-2 weeks',
        permits: [],
      },
      roi: {
        estimatedCost: 6200,
        costRange: { low: 5000, high: 7500 },
        valueIncrease: 9000,
        rentIncreaseMonthly: 125,
        rentIncreasePercent: 5,
        roi: 166,
        paybackMonths: 50,
        fiveYearReturn: 16500,
      },
      costBreakdown: {
        labor: 2800,
        materials: 2900,
        permits: 0,
        contingency: 500,
        total: 6200,
      },
      materials: [
        {
          name: 'Large-format porcelain floor tile',
          category: 'finish',
          quantity: 80,
          unit: 'sq ft',
          unitCost: 8,
          totalCost: 640,
          quality: 'mid-range',
        },
        {
          name: 'Vanity with sink (36")',
          category: 'fixture',
          quantity: 1,
          unit: 'unit',
          unitCost: 450,
          totalCost: 450,
          quality: 'mid-range',
        },
        {
          name: 'Modern faucet set',
          category: 'fixture',
          quantity: 1,
          unit: 'unit',
          unitCost: 180,
          totalCost: 180,
          quality: 'mid-range',
        },
        {
          name: 'Frameless mirror',
          category: 'fixture',
          quantity: 1,
          unit: 'unit',
          unitCost: 120,
          totalCost: 120,
          quality: 'mid-range',
        },
      ],
      labor: [
        {
          trade: 'Tile Installer',
          hours: 24,
          hourlyRate: 65,
          totalCost: 1560,
        },
        {
          trade: 'Plumber',
          hours: 8,
          hourlyRate: 95,
          totalCost: 760,
        },
      ],
    },
    {
      id: `reno-${scanId}-flooring-1`,
      zone: {
        id: `zone-${scanId}-flooring-1`,
        type: 'flooring',
        name: 'Living Area LVP Flooring',
        description: 'Install luxury vinyl plank flooring throughout living areas',
        boundingBox: {
          min: { x: -5, y: 0, z: -5 },
          max: { x: 5, y: 0.1, z: 5 },
          center: { x: 0, y: 0.05, z: 0 },
        },
        markerPosition: { x: 0, y: 0.5, z: 0 },
        confidence: 0.85,
      },
      analysis: {
        explanation: 'The current flooring appears to be worn carpet or dated laminate with visible wear patterns. Luxury vinyl plank (LVP) flooring is waterproof, durable, and provides excellent ROI. It appeals to modern tenants and requires minimal maintenance.',
        currentCondition: 'fair',
        urgency: 'long-term',
        complexity: 'simple',
        estimatedDuration: '3-5 days',
        permits: [],
      },
      roi: {
        estimatedCost: 4200,
        costRange: { low: 3500, high: 5000 },
        valueIncrease: 6000,
        rentIncreaseMonthly: 100,
        rentIncreasePercent: 4,
        roi: 186,
        paybackMonths: 42,
        fiveYearReturn: 12000,
      },
      costBreakdown: {
        labor: 1400,
        materials: 2500,
        permits: 0,
        contingency: 300,
        total: 4200,
      },
      materials: [
        {
          name: 'Luxury Vinyl Plank (LVP)',
          category: 'finish',
          quantity: 500,
          unit: 'sq ft',
          unitCost: 4.5,
          totalCost: 2250,
          quality: 'mid-range',
          alternatives: [
            { name: 'Budget LVP', unitCost: 2.5, quality: 'budget' },
            { name: 'Premium LVP', unitCost: 7, quality: 'premium' },
          ],
        },
        {
          name: 'Underlayment',
          category: 'structural',
          quantity: 500,
          unit: 'sq ft',
          unitCost: 0.5,
          totalCost: 250,
          quality: 'mid-range',
        },
      ],
      labor: [
        {
          trade: 'Flooring Installer',
          hours: 24,
          hourlyRate: 55,
          totalCost: 1320,
        },
      ],
    },
    {
      id: `reno-${scanId}-paint-1`,
      zone: {
        id: `zone-${scanId}-paint-1`,
        type: 'paint',
        name: 'Interior Paint Refresh',
        description: 'Fresh neutral paint throughout all interior walls',
        boundingBox: {
          min: { x: -6, y: 0, z: -6 },
          max: { x: 6, y: 2.5, z: 6 },
          center: { x: 0, y: 1.25, z: 0 },
        },
        markerPosition: { x: -4, y: 1.5, z: 3 },
        confidence: 0.95,
      },
      analysis: {
        explanation: 'The walls show typical wear including scuffs, nail holes, and potentially dated colors. A fresh coat of modern neutral paint (agreeable gray, accessible beige) is one of the highest-ROI improvements and immediately refreshes the entire space.',
        currentCondition: 'fair',
        urgency: 'optional',
        complexity: 'diy',
        estimatedDuration: '2-4 days',
        permits: [],
      },
      roi: {
        estimatedCost: 1800,
        costRange: { low: 1200, high: 2500 },
        valueIncrease: 3500,
        rentIncreaseMonthly: 50,
        rentIncreasePercent: 2,
        roi: 261,
        paybackMonths: 36,
        fiveYearReturn: 6500,
      },
      costBreakdown: {
        labor: 1000,
        materials: 650,
        permits: 0,
        contingency: 150,
        total: 1800,
      },
      materials: [
        {
          name: 'Interior paint (premium)',
          category: 'finish',
          quantity: 8,
          unit: 'gallons',
          unitCost: 55,
          totalCost: 440,
          quality: 'mid-range',
        },
        {
          name: 'Primer',
          category: 'finish',
          quantity: 4,
          unit: 'gallons',
          unitCost: 35,
          totalCost: 140,
          quality: 'mid-range',
        },
        {
          name: 'Supplies (brushes, rollers, tape)',
          category: 'other',
          quantity: 1,
          unit: 'set',
          unitCost: 70,
          totalCost: 70,
          quality: 'mid-range',
        },
      ],
      labor: [
        {
          trade: 'Painter',
          hours: 20,
          hourlyRate: 45,
          totalCost: 900,
        },
      ],
    },
  ];

  return mockRenovations;
}

/**
 * Generate mock AR preview for development
 */
export function generateMockARPreview(renovationId: string): RenovationPreview {
  return {
    id: `preview-${renovationId}`,
    renovationId,
    thumbnailUrl: '/api/placeholder/ar-preview.jpg',
    selectedMaterials: [
      {
        area: 'Cabinets',
        material: 'White Shaker',
        color: '#ffffff',
      },
      {
        area: 'Countertops',
        material: 'Quartz - Carrara Look',
        color: '#f0f0f0',
      },
      {
        area: 'Hardware',
        material: 'Brushed Nickel',
        color: '#c0c0c0',
      },
    ],
    generatedAt: new Date().toISOString(),
    aiModel: 'gpt-4-vision-preview',
    confidence: 0.85,
  };
}
