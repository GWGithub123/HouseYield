/**
 * Room Scanner Types
 * Types for 3D room scanning using Luma AI, DepthPro, and OpenAI
 */

// Scan session state
export interface ScanSession {
  id: string;
  propertyId?: string;
  roomName: string;
  status: 'initializing' | 'scanning' | 'processing' | 'complete' | 'error';
  frames: CapturedFrame[];
  coverage: ScanCoverage;
  model3D?: Model3DResult;
  createdAt: Date;
  completedAt?: Date;
  anchorOrientation?: DeviceOrientation; // First photo's orientation - used as reference point
}

// Anchor-relative orientation tracking for accurate scan coverage
export interface AnchorOrientationState {
  anchor: DeviceOrientation;           // First photo's orientation (reference point)
  isSet: boolean;                       // Whether anchor has been captured
  coveredSectors: Set<number>;          // Sectors (0-7, 45° each) that have been scanned
  lastRelativeAlpha: number;            // Last relative rotation from anchor
}

// Individual captured frame
export interface CapturedFrame {
  id: string;
  timestamp: number;
  imageData: string; // Base64 or URL
  orientation: DeviceOrientation;
  depthMap?: DepthMapResult;
  quality: FrameQuality;
}

// Device orientation from sensors
export interface DeviceOrientation {
  alpha: number; // Z-axis rotation (compass direction)
  beta: number;  // X-axis rotation (front-back tilt)
  gamma: number; // Y-axis rotation (left-right tilt)
  absolute: boolean;
}

// Device motion data
export interface DeviceMotion {
  acceleration: { x: number; y: number; z: number };
  accelerationIncludingGravity: { x: number; y: number; z: number };
  rotationRate: { alpha: number; beta: number; gamma: number };
}

// Frame quality assessment
export interface FrameQuality {
  blur: number;      // 0-1, higher = more blur (bad)
  brightness: number; // 0-1, optimal around 0.5
  contrast: number;   // 0-1, higher = better
  usable: boolean;
  issues: string[];
}

// Depth map result from ZoeDepth (metric depth estimation)
export interface DepthMapResult {
  depthData?: string;       // Base64 encoded depth map image (optional, legacy)
  depthImageData?: string;  // Base64 data URL for depth map (avoids CORS issues)
  depthImageUrl?: string;   // URL to depth map image (from ZoeDepth/Replicate)
  depthDataUrl?: string;    // URL to raw depth data (numpy format) if available
  width: number;
  height: number;
  minDepth: number;         // Minimum depth in meters
  maxDepth: number;         // Maximum depth in meters
  focalLengthPx?: number;
  avgDepth?: number;        // Average depth in meters
  // Metric depth metadata (ZoeDepth specific)
  isMetricDepth?: boolean;  // True if this is metric (absolute) depth, not relative
  unit?: 'meters' | 'feet'; // Unit of depth values
  modelType?: string;       // e.g., 'zoedepth_nk', 'depth_anything_v2'
  assumedFocalLengthMm?: number;  // Camera focal length assumption
  metricAccuracyEstimate?: number; // 0-1, confidence in metric accuracy
  indoorOptimized?: boolean; // True if model is optimized for indoor scenes
}

// Room dimensions calculated from metric depth maps
export interface RoomDimensions {
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
  volumeCuFt?: number;
  volumeCuM?: number;
  // Quality metrics
  confidence: number;       // 0-1, confidence in measurements
  methodology: string;      // How dimensions were calculated
  estimatedAccuracy: string; // e.g., '±10-15%'
}

// Room scan result with dimensions for renovation cost estimation
export interface RoomScanWithDimensions {
  scanSession: ScanSession;
  dimensions: RoomDimensions;
  costEstimateInputs: {
    flooringSqFt: number;
    paintWallSqFt: number;
    ceilingSqFt: number;
    roomType: string;
    roomCount?: number;
  };
}

// Scan coverage tracking
export interface ScanCoverage {
  percentage: number;  // 0-100
  scannedAreas: ScannedArea[];
  missingAreas: string[];
  estimatedTimeRemaining: number; // seconds
}

export interface ScannedArea {
  name: string;
  direction: 'north' | 'south' | 'east' | 'west' | 'up' | 'down' | 'center';
  coverage: number; // 0-100
  frameIds: string[];
}

// AI Guidance for scanning
export interface ScanGuidance {
  command: ScanCommand;
  message: string;
  visualGuide?: VisualGuide;
  confidence: number;
  priority: 'low' | 'medium' | 'high';
}

export type ScanCommand = 
  | 'turn_left'
  | 'turn_right'
  | 'move_forward'
  | 'move_back'
  | 'look_up'
  | 'look_down'
  | 'hold_steady'
  | 'scan_corner'
  | 'get_closer'
  | 'step_back'
  | 'slow_down'
  | 'speed_up'
  | 'improve_lighting'
  | 'reduce_motion'
  | 'capture_detail'
  | 'scan_complete';

export interface VisualGuide {
  type: 'arrow' | 'highlight' | 'boundary' | 'target';
  position: { x: number; y: number };
  direction?: number; // degrees
  color?: string;
  size?: number;
}

// 3D Model result from Luma
export interface Model3DResult {
  modelUrl: string;      // URL to GLB/GLTF file
  thumbnailUrl: string;
  format: 'glb' | 'gltf' | 'usdz' | 'obj';
  fileSize: number;      // bytes
  dimensions: {
    width: number;       // meters
    height: number;      // meters
    depth: number;       // meters
  };
  vertexCount: number;
  textured: boolean;
  processingTime: number; // seconds
}

// Luma AI API types
export interface LumaCreateCaptureRequest {
  title: string;
  type: 'splat' | 'nerf';
}

export interface LumaUploadResponse {
  capture: {
    uuid: string;
    title: string;
    status: 'uploading' | 'processing' | 'ready' | 'failed';
    created_at: string;
  };
  signedUrls?: {
    source: string;
  };
}

export interface LumaCaptureStatus {
  uuid: string;
  title: string;
  status: 'uploading' | 'processing' | 'ready' | 'failed';
  progress?: number;
  latestRun?: {
    status: string;
    progress?: number;
  };
  artifacts?: {
    splat?: string;
    ply?: string;
    gaussian_splat_ply?: string;
  };
}

// OpenAI Vision analysis
export interface FrameAnalysis {
  roomType: string;
  visibleFeatures: string[];
  missingAreas: string[];
  lightingQuality: 'poor' | 'fair' | 'good' | 'excellent';
  suggestedAction: ScanCommand;
  detailedFeedback: string;
}

// Scanner configuration
export interface ScannerConfig {
  captureInterval: number;      // ms between captures
  minFrames: number;            // minimum frames for reconstruction
  maxFrames: number;            // maximum frames to capture
  autoCapture: boolean;         // capture automatically vs manual
  enableVoiceGuidance: boolean;
  enableDepthPreview: boolean;
  targetCoverage: number;       // percentage (e.g., 85)
  resolution: 'low' | 'medium' | 'high';
}

// Scanner state for UI
export interface ScannerState {
  isInitialized: boolean;
  isScanning: boolean;
  isPaused: boolean;
  isProcessing: boolean;
  currentGuidance: ScanGuidance | null;
  frameCount: number;
  coverage: number;
  error: string | null;
  model: Model3DResult | null;
}

// API response types
export interface DepthProResponse {
  success: boolean;
  depth?: DepthMapResult;
  error?: string;
  processingTime: number;
}

export interface GuidanceResponse {
  success: boolean;
  guidance?: ScanGuidance;
  frameAnalysis?: FrameAnalysis;
  error?: string;
}

export interface Model3DResponse {
  success: boolean;
  model?: Model3DResult;
  error?: string;
  jobId?: string;
  status?: 'queued' | 'processing' | 'complete' | 'failed';
  progress?: number;
}
