/**
 * Live Renovation Assessment Types
 * 
 * Types for the live AI-powered renovation scanning system that combines:
 * - Real-time AI vision analysis (GPT-4V watching the camera feed)
 * - Photogrammetry-style quality capture (reuses existing services)
 * - Metric3D depth estimation for room/object measurements
 * - Smart photo tagging and focus requests
 */

import { Vector3, Quaternion, QualityMetrics } from './photogrammetry';

// =============================================================================
// SCAN SESSION
// =============================================================================

export interface RenovationScanSession {
  id: string;
  propertyId?: string;
  roomName: string;
  roomType?: string;
  address?: string;
  zipCode?: string;
  startedAt: number;
  completedAt?: number;
  status: 'initializing' | 'scanning' | 'processing' | 'completed' | 'error';
  
  // Captured data
  captures: RenovationCapture[];
  aiGuidanceHistory: AIGuidanceMessage[];
  
  // Coverage tracking (from photogrammetry)
  coveragePercent: number;
  
  // Measurements (populated after Metric3D processing)
  roomMeasurements?: RoomMeasurements;
  objectMeasurements?: ObjectMeasurement[];
  
  // Final results
  suggestions?: RenovationSuggestion[];
  error?: string;
}

// =============================================================================
// CAPTURES
// =============================================================================

export interface RenovationCapture {
  id: string;
  timestamp: number;
  imageData: string; // Base64
  
  // From photogrammetry services
  orientation: {
    yaw: number;    // Compass direction (0-360)
    pitch: number;  // Up/down tilt (-90 to 90)
    roll: number;   // Rotation
  };
  position?: Vector3;
  qualityMetrics: QualityMetrics;
  
  // AI tagging
  tag?: CaptureTag;
  aiNotes?: string;
  
  // Capture trigger
  trigger: CaptureTrigger;
  
  // For object-focused captures
  focusRequest?: FocusRequest;
  
  // Metric3D results (populated during processing)
  depthData?: {
    depthMapUrl?: string;
    minDepth: number;
    maxDepth: number;
    isMetric: boolean;
  };
}

export type CaptureTag = 
  | 'floor'
  | 'ceiling'
  | 'wall'
  | 'kitchen'
  | 'bathroom'
  | 'vanity'
  | 'bathtub'
  | 'shower'
  | 'toilet'
  | 'cabinets'
  | 'countertop'
  | 'appliances'
  | 'window'
  | 'door'
  | 'lighting'
  | 'hvac'
  | 'general'
  | 'overview';

export type CaptureTrigger = 
  | 'auto'           // Quality + stability triggered
  | 'ai_request'     // AI asked for this specific shot
  | 'manual'         // User tapped capture
  | 'coverage'       // Coverage gap detected
  | 'focus_complete' // Completed focus request
  | 'periodic';      // Time-based general capture

// =============================================================================
// AI GUIDANCE
// =============================================================================

export interface AIGuidanceMessage {
  id: string;
  timestamp: number;
  type: AIGuidanceType;
  message: string;
  
  // For focus requests
  focusRequest?: FocusRequest;
  
  // For capture triggers
  triggerCapture?: boolean;
  
  // Voice synthesis
  speak?: boolean;
  priority: 'low' | 'normal' | 'high';
}

export type AIGuidanceType = 
  | 'greeting'           // Initial welcome message
  | 'instruction'        // General scanning instructions
  | 'observation'        // AI noticed something
  | 'focus_request'      // AI wants a closer look at something
  | 'capture_triggered'  // AI triggered a capture
  | 'coverage_hint'      // Guidance to cover missed areas
  | 'quality_warning'    // Blur/motion warning
  | 'measurement_mode'   // Entering object measurement
  | 'progress'           // Scan progress update
  | 'completion';        // Scan complete

export interface FocusRequest {
  id: string;
  target: string;           // What to focus on ("bathtub", "floor near window", etc.)
  reason: string;           // Why AI wants this ("I see worn tiles here")
  suggestedTag: CaptureTag;
  status: 'pending' | 'in_progress' | 'completed' | 'skipped';
  completedCaptures: string[]; // IDs of captures that fulfilled this request
}

// =============================================================================
// MEASUREMENTS
// =============================================================================

export interface RoomMeasurements {
  // Dimensions in feet
  widthFeet: number;
  lengthFeet: number;
  heightFeet: number;
  
  // Dimensions in meters
  widthMeters: number;
  lengthMeters: number;
  heightMeters: number;
  
  // Calculated areas
  floorAreaSqFt: number;
  floorAreaSqM: number;
  wallAreaSqFt: number;
  wallAreaSqM: number;
  
  // Volume
  volumeCuFt: number;
  volumeCuM: number;
  
  // Confidence
  confidence: number; // 0-1
  methodology: 'metric3d' | 'zoedepth' | 'estimated';
}

export interface ObjectMeasurement {
  id: string;
  type: CaptureTag;
  name: string;           // "Bathroom Vanity", "Bathtub", etc.
  
  // Dimensions in inches
  widthInches: number;
  depthInches: number;
  heightInches?: number;
  
  // Standard size match
  standardSize?: string;  // "36-inch vanity", "60-inch alcove tub"
  
  // Source captures
  captureIds: string[];
  
  // Confidence
  confidence: number;
}

// =============================================================================
// RENOVATION SUGGESTIONS (Enhanced)
// =============================================================================

export interface RenovationSuggestion {
  id: string;
  
  // Basic info
  name: string;
  type: string;
  summary: string;
  details: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  
  // Cost with PRECISE quantities
  cost: number;
  costRange: { low: number; high: number };
  materialBreakdown?: MaterialItem[];
  laborBreakdown?: LaborItem[];
  
  // Quantities based on ACTUAL measurements
  quantities?: {
    sqFt?: number;
    linearFeet?: number;
    units?: number;
    description: string;
  };
  
  // ROI metrics
  valueIncrease: number;
  rentIncreaseDollar: number;
  rentIncreasePercent: number;
  roi: number;
  paybackMonths: number;
  
  // Visual
  captureIds: string[];       // Photos showing this issue
  previewImageUrl?: string;   // AI-generated preview
  previewGenerating?: boolean;
  
  // 3D position (for mesh overlay)
  markerPosition?: Vector3;
  boundingBox?: {
    min: Vector3;
    max: Vector3;
  };
}

export interface MaterialItem {
  name: string;
  quantity: number;
  unit: string;
  unitCost: number;
  totalCost: number;
  source?: string;
}

export interface LaborItem {
  task: string;
  hours: number;
  hourlyRate: number;
  totalCost: number;
  tradeType: string;
}

// =============================================================================
// LIVE ANALYSIS
// =============================================================================

export interface LiveAnalysisRequest {
  frameData: string;        // Base64 image
  sessionContext: {
    captureCount: number;
    coveragePercent: number;
    recentTags: CaptureTag[];
    pendingFocusRequests: FocusRequest[];
    roomType?: string;      // Detected room type
  };
}

export interface LiveAnalysisResponse {
  success: boolean;
  
  // What AI sees
  observations: string[];
  detectedRoomType?: string;
  
  // Guidance
  guidance?: AIGuidanceMessage;
  
  // New focus requests
  newFocusRequests?: FocusRequest[];
  
  // Capture triggers
  triggerCapture?: boolean;
  captureTag?: CaptureTag;
  captureReason?: string;
  
  // Preliminary renovation notes
  preliminarySuggestions?: string[];
  
  // Processing metadata
  processingTimeMs: number;
}

// =============================================================================
// API PAYLOADS
// =============================================================================

export interface AssessFromScanRequest {
  scanId: string;
  captures: RenovationCapture[];
  propertyData: {
    address: string;
    zipCode?: string;
    propertyValue?: number;
    monthlyRent?: number;
    bedrooms?: number;
    bathrooms?: number;
    squareFeet?: number;
    yearBuilt?: number;
  };
}

export interface AssessFromScanResponse {
  success: boolean;
  scanId: string;
  
  // Measurements
  roomMeasurements: RoomMeasurements;
  objectMeasurements: ObjectMeasurement[];
  
  // Suggestions with precise costs
  suggestions: RenovationSuggestion[];
  
  // Summary
  summary: {
    totalRenovationCost: number;
    totalValueIncrease: number;
    totalRentIncrease: number;
    overallROI: number;
    topPriority: string;
  };
  
  // Processing info
  processingTimeMs: number;
  measurementSource: 'metric3d' | 'zoedepth' | 'estimated';
  
  error?: string;
}

// =============================================================================
// METRIC3D TYPES
// =============================================================================

export interface Metric3DRequest {
  imageBase64: string;
  returnDepthMap?: boolean;
}

export interface Metric3DResponse {
  success: boolean;
  depthMap?: string;        // Base64 depth image
  minDepth: number;         // Meters
  maxDepth: number;         // Meters
  meanDepth: number;        // Meters
  processingTimeMs: number;
  error?: string;
}

export interface ObjectMeasurementRequest {
  imageBase64: string;
  boundingBox?: {           // Optional: focus area
    x: number;
    y: number;
    width: number;
    height: number;
  };
  objectType: CaptureTag;
  cameraFOV?: number;       // Horizontal FOV in degrees (default 70)
}

export interface ObjectMeasurementResponse {
  success: boolean;
  widthInches: number;
  depthInches: number;
  heightInches?: number;
  confidence: number;
  standardMatch?: string;
  error?: string;
}

// =============================================================================
// HELPERS
// =============================================================================

export function generateCaptureId(): string {
  return `cap_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

export function generateSessionId(): string {
  return `reno_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

export function generateFocusRequestId(): string {
  return `focus_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

export function createEmptySession(roomName: string, propertyId?: string): RenovationScanSession {
  return {
    id: generateSessionId(),
    propertyId,
    roomName,
    startedAt: Date.now(),
    status: 'initializing',
    captures: [],
    aiGuidanceHistory: [],
    coveragePercent: 0,
  };
}
