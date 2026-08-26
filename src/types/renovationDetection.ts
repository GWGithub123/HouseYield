/**
 * Renovation Detection Types
 * Types for AI-powered renovation detection and visualization in 3D scans
 */

// ============================================================================
// Core Detection Types
// ============================================================================

/**
 * 3D bounding box for renovation area
 */
export interface RenovationBoundingBox {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
  center: { x: number; y: number; z: number };
}

/**
 * Detected renovation zone within a 3D scan
 */
export interface RenovationZone {
  id: string;
  type: RenovationType;
  name: string;
  description: string;
  
  // 3D positioning
  boundingBox: RenovationBoundingBox;
  markerPosition: { x: number; y: number; z: number };
  outlinePoints?: Array<{ x: number; y: number; z: number }>;
  
  // Confidence score from AI detection (0-1)
  confidence: number;
  
  // Source image indices used for detection
  sourceImageIndices?: number[];
}

/**
 * Renovation type categories
 */
export type RenovationType = 
  | 'kitchen'
  | 'bathroom'
  | 'flooring'
  | 'paint'
  | 'lighting'
  | 'cabinets'
  | 'countertops'
  | 'appliances'
  | 'windows'
  | 'doors'
  | 'ceiling'
  | 'walls'
  | 'plumbing'
  | 'electrical'
  | 'hvac'
  | 'landscaping'
  | 'deck'
  | 'roof'
  | 'siding'
  | 'basement'
  | 'garage'
  | 'other';

// ============================================================================
// Financial Analysis Types
// ============================================================================

/**
 * Cost breakdown for a renovation
 */
export interface RenovationCostBreakdown {
  labor: number;
  materials: number;
  permits: number;
  contingency: number;
  total: number;
}

/**
 * Detailed materials list
 */
export interface MaterialItem {
  name: string;
  category: 'structural' | 'finish' | 'fixture' | 'appliance' | 'hardware' | 'other';
  quantity: number;
  unit: string;
  unitCost: number;
  totalCost: number;
  quality: 'budget' | 'mid-range' | 'premium' | 'luxury';
  alternatives?: Array<{
    name: string;
    unitCost: number;
    quality: 'budget' | 'mid-range' | 'premium' | 'luxury';
  }>;
}

/**
 * Labor requirements
 */
export interface LaborRequirement {
  trade: string; // e.g., "Electrician", "Plumber", "General Contractor"
  hours: number;
  hourlyRate: number;
  totalCost: number;
}

/**
 * ROI Analysis for a renovation
 */
export interface RenovationROI {
  estimatedCost: number;
  costRange: { low: number; high: number };
  valueIncrease: number;
  rentIncreaseMonthly: number;
  rentIncreasePercent: number;
  roi: number; // Percentage
  paybackMonths: number | null;
  fiveYearReturn: number;
}

// ============================================================================
// Detected Renovation (Full Analysis)
// ============================================================================

/**
 * Full AI-detected renovation with analysis
 */
export interface DetectedRenovation {
  id: string;
  zone: RenovationZone;
  
  // Analysis results
  analysis: {
    explanation: string;
    currentCondition: 'poor' | 'fair' | 'good' | 'excellent';
    urgency: 'immediate' | 'short-term' | 'long-term' | 'optional';
    complexity: 'diy' | 'simple' | 'moderate' | 'complex' | 'major';
    estimatedDuration: string; // e.g., "2-3 weeks"
    permits?: string[];
  };
  
  // Financial analysis
  roi: RenovationROI;
  costBreakdown: RenovationCostBreakdown;
  materials: MaterialItem[];
  labor: LaborRequirement[];
  
  // User preferences (for marketplace listing)
  userBudget?: number;
  preferredStartDate?: string;
  flexibleTimeline?: boolean;
}

// ============================================================================
// AR Preview Types
// ============================================================================

/**
 * AR renovation preview configuration
 */
export interface ARPreviewConfig {
  renovationId: string;
  meshUrl?: string; // URL to AR overlay mesh
  textureUrl?: string; // URL to AR overlay texture
  materialPreset?: 'budget' | 'mid-range' | 'premium' | 'luxury';
  opacity: number;
  visible: boolean;
}

/**
 * AR visualization state
 */
export interface ARVisualizationState {
  enabled: boolean;
  currentPreview: ARPreviewConfig | null;
  generatingPreview: boolean;
  previewError?: string;
}

/**
 * Theoretical final product after renovation
 */
export interface RenovationPreview {
  id: string;
  renovationId: string;
  
  // 3D assets
  meshUrl?: string;
  textureUrl?: string;
  thumbnailUrl?: string;
  
  // Material selections used in preview
  selectedMaterials: Array<{
    area: string;
    material: string;
    color?: string;
    textureUrl?: string;
  }>;
  
  // Generation metadata
  generatedAt: string;
  aiModel: string;
  confidence: number;
}

// ============================================================================
// Marker Types (for 3D visualization)
// ============================================================================

/**
 * 3D marker for renovation zone
 */
export interface RenovationMarker {
  id: string;
  renovationId: string;
  position: { x: number; y: number; z: number };
  color: string;
  icon: RenovationIconType;
  label: string;
  priority: 'high' | 'medium' | 'low';
  expanded: boolean;
}

export type RenovationIconType = 
  | 'kitchen'
  | 'bathroom'
  | 'flooring'
  | 'paint'
  | 'electrical'
  | 'plumbing'
  | 'window'
  | 'door'
  | 'hvac'
  | 'general';

// ============================================================================
// API Request/Response Types
// ============================================================================

/**
 * Mesh bounding box for accurate overlay positioning
 */
export interface MeshBoundsData {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

/**
 * Request to detect renovations from a scan
 */
export interface DetectRenovationsRequest {
  scanId: string;
  propertyAddress?: string;
  propertyValue?: number;
  estimatedRent?: number;
  yearBuilt?: number;
  squareFeet?: number;
  includeARPreviews?: boolean;
  meshBounds?: MeshBoundsData;  // Client-side mesh analysis for accurate positioning
}

/**
 * Response from renovation detection API
 */
export interface DetectRenovationsResponse {
  success: boolean;
  scanId: string;
  renovations: DetectedRenovation[];
  totalEstimatedCost: number;
  totalValueIncrease: number;
  totalRentIncrease: number;
  overallROI: number;
  processingTimeMs: number;
  error?: string;
  warning?: string;  // For demo/fallback data notices
}

/**
 * Request to generate AR preview
 */
export interface GenerateARPreviewRequest {
  renovationId: string;
  scanId: string;
  materialPreset?: 'budget' | 'mid-range' | 'premium' | 'luxury';
  customMaterials?: Array<{
    area: string;
    material: string;
    color?: string;
  }>;
}

/**
 * Response from AR preview generation
 */
export interface GenerateARPreviewResponse {
  success: boolean;
  preview?: RenovationPreview;
  error?: string;
}

// ============================================================================
// Marketplace Integration Types
// ============================================================================

/**
 * Data for creating a marketplace listing from detected renovation
 */
export interface RenovationToMarketplaceData {
  renovationId: string;
  scanId: string;
  
  // Pre-filled from detection
  renovationType: RenovationType;
  renovationDescription: string;
  estimatedCostRange: { low: number; high: number };
  materials: MaterialItem[];
  labor: LaborRequirement[];
  
  // User inputs
  propertyAddress: string;
  budgetAllocation: number;
  desiredStartDate?: string;
  flexibleTimeline: boolean;
  additionalNotes?: string;
  
  // 3D model references
  modelFiles: {
    glb?: string;
    obj?: string;
    mtl?: string;
    texture?: string;
  };
  
  // Zone highlighting data
  highlightedZone: RenovationZone;
  arPreview?: RenovationPreview;
}

/**
 * User's renovation budget preferences
 */
export interface RenovationBudgetPreferences {
  totalBudget: number;
  categoryAllocations?: Record<RenovationType, number>;
  priorityOrder?: RenovationType[];
  materialQuality: 'budget' | 'mid-range' | 'premium' | 'luxury';
}

// ============================================================================
// State Management Types
// ============================================================================

/**
 * Overall renovation detection state for viewer
 */
export interface RenovationDetectionState {
  // Detection status
  isDetecting: boolean;
  detectionComplete: boolean;
  detectionError?: string;
  
  // Detected renovations
  renovations: DetectedRenovation[];
  selectedRenovationId: string | null;
  
  // UI state
  showMarkers: boolean;
  showHighlights: boolean;
  showDetailsModal: boolean;
  showMarketplaceModal: boolean;
  
  // AR visualization
  arState: ARVisualizationState;
  
  // Totals
  totalEstimatedCost: number;
  totalValueIncrease: number;
  totalRentIncrease: number;
  overallROI: number;
}

/**
 * Initial state factory
 */
export function createInitialDetectionState(): RenovationDetectionState {
  return {
    isDetecting: false,
    detectionComplete: false,
    renovations: [],
    selectedRenovationId: null,
    showMarkers: true,
    showHighlights: true,
    showDetailsModal: false,
    showMarketplaceModal: false,
    arState: {
      enabled: false,
      currentPreview: null,
      generatingPreview: false,
    },
    totalEstimatedCost: 0,
    totalValueIncrease: 0,
    totalRentIncrease: 0,
    overallROI: 0,
  };
}

// ============================================================================
// Helper Type Guards
// ============================================================================

export function isRenovationType(value: string): value is RenovationType {
  const validTypes: RenovationType[] = [
    'kitchen', 'bathroom', 'flooring', 'paint', 'lighting', 'cabinets',
    'countertops', 'appliances', 'windows', 'doors', 'ceiling', 'walls',
    'plumbing', 'electrical', 'hvac', 'landscaping', 'deck', 'roof',
    'siding', 'basement', 'garage', 'other'
  ];
  return validTypes.includes(value as RenovationType);
}

export function getRenovationColor(type: RenovationType): string {
  const colors: Record<RenovationType, string> = {
    kitchen: '#f97316',      // orange
    bathroom: '#3b82f6',     // blue
    flooring: '#8b5cf6',     // purple
    paint: '#ec4899',        // pink
    lighting: '#eab308',     // yellow
    cabinets: '#f97316',     // orange
    countertops: '#6366f1',  // indigo
    appliances: '#14b8a6',   // teal
    windows: '#06b6d4',      // cyan
    doors: '#a855f7',        // purple
    ceiling: '#f43f5e',      // rose
    walls: '#ef4444',        // red
    plumbing: '#0ea5e9',     // sky
    electrical: '#fbbf24',   // amber
    hvac: '#10b981',         // emerald
    landscaping: '#22c55e',  // green
    deck: '#78350f',         // brown
    roof: '#64748b',         // slate
    siding: '#94a3b8',       // gray
    basement: '#71717a',     // zinc
    garage: '#525252',       // neutral
    other: '#6b7280',        // gray
  };
  return colors[type] || '#6b7280';
}

export function getRenovationIcon(type: RenovationType): string {
  const icons: Record<RenovationType, string> = {
    kitchen: '🍳',
    bathroom: '🚿',
    flooring: '🪵',
    paint: '🎨',
    lighting: '💡',
    cabinets: '🗄️',
    countertops: '🔲',
    appliances: '🔌',
    windows: '🪟',
    doors: '🚪',
    ceiling: '⬆️',
    walls: '🧱',
    plumbing: '🔧',
    electrical: '⚡',
    hvac: '❄️',
    landscaping: '🌳',
    deck: '🪴',
    roof: '🏠',
    siding: '🏡',
    basement: '🏚️',
    garage: '🚗',
    other: '🔨',
  };
  return icons[type] || '🔨';
}
