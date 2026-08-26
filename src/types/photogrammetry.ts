/**
 * Photogrammetry System Types
 * 
 * Complete type definitions for the multi-position photogrammetry pipeline:
 * - Continuous capture with position tracking
 * - Real-time coverage monitoring
 * - SfM reconstruction
 * - Mesh generation and texturing
 * - Virtual walkthrough navigation
 */

import { iPhoneSensorData, CameraIntrinsics } from './panoramaScanner';

// Re-export for backwards compatibility
export type { CameraIntrinsics };

// =============================================================================
// VECTOR & MATH TYPES
// =============================================================================

export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

export interface Quaternion {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface BoundingBox3D {
  min: Vector3;
  max: Vector3;
  center: Vector3;
  size: Vector3;
}

export interface Matrix3x3 {
  elements: number[][]; // 3x3 rotation matrix
}

export interface Matrix4x4 {
  elements: number[][]; // 4x4 transformation matrix
}

// =============================================================================
// CAPTURE TYPES
// =============================================================================

/**
 * Configuration for auto-capture behavior
 */
export interface CaptureConfig {
  mode: 'smart' | 'time' | 'distance' | 'rotation' | 'manual';
  timeInterval: number;        // Capture every N milliseconds (for time mode)
  distanceThreshold: number;   // Capture every N meters moved
  rotationThreshold: number;   // Capture every N degrees rotated
  minTimeBetweenCaptures: number; // Minimum ms between any captures
}

export const DEFAULT_CAPTURE_CONFIG: CaptureConfig = {
  mode: 'smart',
  timeInterval: 1000,          // 1 second (more frequent for better coverage)
  distanceThreshold: 0.10,     // 10cm (capture more when moving)
  rotationThreshold: 8,        // 8 degrees (capture more when rotating)
  minTimeBetweenCaptures: 300, // 300ms minimum (allow faster captures)
};

/**
 * AR-derived pose from WebXR (Pipeline v2)
 * Provides metric-scale camera positions in real-world meters
 */
export interface ARPoseData {
  position: Vector3;           // Meters from AR session origin
  rotation: Quaternion;        // Camera orientation (xyzw quaternion)
  confidence: 'high' | 'medium' | 'low';
  timestamp: number;           // DOMHighResTimeStamp
}

/**
 * Single photo captured during photogrammetry scan
 */
export interface PhotogrammetryPhoto {
  id: string;
  imageData: string;           // Base64 or blob URL
  timestamp: number;
  sequenceIndex: number;       // Order in capture sequence
  
  // Capture-time pose estimate (from IMU/tracking)
  estimatedPosition: Vector3;
  estimatedRotation: Quaternion;
  
  // Raw sensor data
  imuData?: iPhoneSensorData;
  cameraIntrinsics?: CameraIntrinsics;
  
  // Direction camera was facing (for coverage tracking)
  azimuth: number;             // 0-360° horizontal
  elevation: number;           // -90° to +90° vertical
  
  // AR-derived metric pose (Pipeline v2) - NEW
  arPose?: ARPoseData;         // Metric-scale pose from WebXR AR
  hasARPose?: boolean;         // Whether AR tracking was active
  
  // Refined pose (filled after SfM processing)
  refinedPosition?: Vector3;
  refinedRotation?: Quaternion;
  poseConfidence?: number;     // 0-1, how confident is the pose
  
  // Feature data (filled after feature extraction)
  featureCount?: number;
  matchedPhotos?: string[];    // IDs of photos this one matches with
}

/**
 * Cluster of photos taken from similar position
 */
export interface PositionCluster {
  id: string;
  centerPosition: Vector3;
  radius: number;              // Cluster radius in meters
  photoIds: string[];
  primaryPhotoId: string;      // Best photo to represent this cluster
  captureStartTime: number;
  captureEndTime: number;
}

/**
 * AR tracking metadata for the scan (Pipeline v2)
 */
export interface ARTrackingMetadata {
  wasAvailable: boolean;       // Whether AR was supported on device
  wasActive: boolean;          // Whether AR was successfully started
  photosWithAR: number;        // Number of photos with AR poses
  totalPhotos: number;         // Total photos in scan
  trackingQuality: 'high' | 'medium' | 'low' | 'unavailable';
  planesDetected: number;      // Number of AR planes found
  sessionDuration: number;     // AR session duration in seconds
}

/**
 * Complete photogrammetry scan session
 */
export interface PhotogrammetryScan {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  
  // Capture data
  photos: PhotogrammetryPhoto[];
  clusters: PositionCluster[];
  pathLength: number;          // Total distance walked (meters)
  captureTime: number;         // Total capture duration (seconds)
  
  // AR tracking metadata (Pipeline v2) - NEW
  arTracking?: ARTrackingMetadata;
  
  // Processing status
  status: PhotogrammetryStatus;
  processingProgress: ProcessingProgress;
  
  // Results (filled after processing)
  sfmResult?: SfMResult;
  pointCloud?: PointCloudResult;
  mesh?: MeshResult;
  navigation?: NavigationResult;
  
  // Measurements (Pipeline v2) - NEW
  measurements?: RoomMeasurements;
  
  // Metadata
  propertyId?: string;
  roomName?: string;
  deviceInfo?: DeviceInfo;
  
  // Pipeline version used
  pipelineVersion?: 'v1' | 'v2' | 'hybrid_v1' | 'master_v1';
  captureMode?: 'image_sequence' | 'room_tour';
}

/**
 * Room measurements from v2 pipeline
 */
export interface RoomMeasurements {
  roomDimensions?: {
    length: number;            // meters
    width: number;
    height: number;
    area: number;              // square meters
    volume: number;            // cubic meters
  };
  cabinets?: CabinetMeasurement[];
  doors?: DoorMeasurement[];
  windows?: WindowMeasurement[];
  counters?: CounterMeasurement[];
  accuracy: {
    roomDimensions: string;    // e.g., "±2cm"
    cabinets: string;          // e.g., "±5mm"
    scale: string;             // e.g., "±1%"
  };
}

export interface CabinetMeasurement {
  id: string;
  type: 'upper' | 'lower' | 'tall' | 'island';
  position: Vector3;
  dimensions: {
    width: number;
    height: number;
    depth: number;
  };
  confidence: number;
}

export interface DoorMeasurement {
  id: string;
  type: 'interior' | 'exterior' | 'closet';
  position: Vector3;
  dimensions: {
    width: number;
    height: number;
  };
  isOpen: boolean;
}

export interface WindowMeasurement {
  id: string;
  position: Vector3;
  dimensions: {
    width: number;
    height: number;
  };
  sillHeight: number;          // Height from floor
}

export interface CounterMeasurement {
  id: string;
  position: Vector3;
  dimensions: {
    length: number;
    depth: number;
    height: number;
  };
}

export type PhotogrammetryStatus = 
  | 'capturing'
  | 'uploading'
  | 'queued'
  | 'extracting_features'
  | 'matching_features'
  | 'sparse_reconstruction'
  | 'dense_reconstruction'
  | 'generating_mesh'
  | 'texturing'
  | 'generating_navigation'
  | 'complete'
  | 'failed';

export interface ProcessingProgress {
  phase: PhotogrammetryStatus;
  percent: number;             // 0-100
  message: string;
  startTime?: number;
  estimatedTimeRemaining?: number; // seconds
  errors?: string[];
}

export interface DeviceInfo {
  userAgent: string;
  platform: string;
  hasGyroscope: boolean;
  hasAccelerometer: boolean;
  hasARKit: boolean;
  screenWidth: number;
  screenHeight: number;
}

// =============================================================================
// COVERAGE TRACKING TYPES
// =============================================================================

/**
 * Single cell in the spherical coverage grid
 */
export interface CoverageCell {
  azimuth: number;             // Center azimuth of cell (0-360°)
  elevation: number;           // Center elevation of cell (-90° to +90°)
  cellWidth: number;           // Width in degrees
  cellHeight: number;          // Height in degrees
  
  viewCount: number;           // How many photos cover this cell
  positionIds: string[];       // Which position clusters see this cell
  photoIds: string[];          // Which photos see this cell
  
  // Quality metrics
  triangulatable: boolean;     // Seen from 2+ positions with good baseline
  averageDistance: number;     // Average distance to surfaces in this direction
  confidence: number;          // 0-1, overall coverage quality
}

/**
 * Spherical coverage grid (typically 10° cells = 36×18 = 648 cells)
 */
export interface CoverageGrid {
  cellSize: number;            // Degrees per cell (e.g., 10)
  cells: CoverageCell[][];     // [azimuth][elevation] indexed
  
  // Summary statistics
  overallCoverage: number;     // 0-100%, how much of sphere is covered
  triangulatableCoverage: number; // 0-100%, how much can be triangulated
  largestGap: number;          // Largest uncovered region in degrees
  gapLocations: Array<{ azimuth: number; elevation: number }>;
}

/**
 * Floor grid for position coverage (tracks where user has walked)
 */
export interface FloorGrid {
  cellSize: number;            // Meters per cell (e.g., 0.5)
  cells: Map<string, FloorCell>; // "x,y" -> cell
  bounds: BoundingBox3D;
}

export interface FloorCell {
  x: number;                   // Grid X coordinate
  y: number;                   // Grid Y coordinate
  worldX: number;              // World X position (meters)
  worldY: number;              // World Y position (meters)
  visitCount: number;          // How many times user stood here
  photosTaken: number;         // Photos captured from this cell
  photoIds: string[];
}

/**
 * Detected object for coverage analysis
 */
export interface DetectedObject {
  id: string;
  type: 'furniture' | 'fixture' | 'appliance' | 'unknown';
  label?: string;              // "couch", "bookshelf", etc.
  boundingBox: BoundingBox3D;
  
  // Coverage analysis
  viewAngles: number[];        // Azimuths from which it's been photographed
  viewPositions: string[];     // Position cluster IDs that see it
  coverage: number;            // 0-100%
  requiredViews: number;       // Based on object size/complexity
  actualViews: number;
  
  // Detection source
  detectedFrom: 'depth' | 'segmentation' | 'manual';
  confidence: number;
}

/**
 * Region that needs more coverage
 */
export interface MissingRegion {
  id: string;
  azimuth: number;
  elevation: number;
  size: number;                // Approximate size in degrees
  severity: 'critical' | 'warning' | 'minor';
  reason: string;              // "Object back not visible", "Wall corner gap"
  
  // Guidance for user
  suggestedPosition?: Vector3;
  suggestedDirection?: number; // Azimuth to face
  suggestedDistance?: number;  // How far to move
}

/**
 * Complete coverage analysis report
 */
export interface CoverageReport {
  timestamp: number;
  
  // Overall metrics
  overallCoverage: number;     // 0-100%
  triangulatableCoverage: number;
  positionsCovered: number;    // How many distinct positions
  
  // Detailed data
  grid: CoverageGrid;
  floorGrid: FloorGrid;
  objects: DetectedObject[];
  missingRegions: MissingRegion[];
  
  // Recommendations
  recommendations: CaptureRecommendation[];
  readyForProcessing: boolean;
  readinessScore: number;      // 0-100
}

/**
 * Recommendation for next capture action
 */
export interface CaptureRecommendation {
  type: 'rotate' | 'move' | 'detail' | 'complete';
  priority: 'high' | 'medium' | 'low';
  message: string;
  
  // For rotate
  targetAzimuth?: number;
  
  // For move
  targetPosition?: Vector3;
  targetDirection?: number;
  
  // For detail
  targetObject?: string;       // Object ID to get closer to
}

// =============================================================================
// STRUCTURE FROM MOTION (SfM) TYPES
// =============================================================================

/**
 * Camera parameters recovered by SfM
 */
export interface SfMCamera {
  id: string;
  photoId: string;
  imagePath: string;
  
  // Pose
  position: Vector3;
  rotation: Quaternion;
  rotationMatrix: Matrix3x3;
  
  // Intrinsics
  focalLength: number;         // Pixels
  principalPoint: { x: number; y: number };
  distortionCoeffs?: number[]; // k1, k2, p1, p2, k3
  
  // Quality
  registrationError: number;
  numVisiblePoints: number;
}

/**
 * 3D point from sparse reconstruction
 */
export interface SfMPoint3D {
  id: string;
  position: Vector3;
  color: { r: number; g: number; b: number };
  error: number;               // Reprojection error
  trackLength: number;         // How many images see this point
  imageIds: string[];          // Which images see it
}

/**
 * Result of Structure from Motion
 */
export interface SfMResult {
  cameras: SfMCamera[];
  points: SfMPoint3D[];
  
  // Statistics
  numRegisteredImages: number;
  numTotalImages: number;
  registrationRate: number;    // 0-1
  meanReprojectionError: number;
  
  // Scale and alignment
  scale: number;               // Meters per unit
  scaleSource: 'imu' | 'reference' | 'estimated';
  worldUp: Vector3;            // Which direction is up
  
  // Timing
  processingTime: number;      // Seconds
}

// =============================================================================
// POINT CLOUD TYPES
// =============================================================================

/**
 * Single point in dense point cloud
 */
export interface DensePoint3D {
  x: number;
  y: number;
  z: number;
  r: number;                   // Color 0-255
  g: number;
  b: number;
  nx?: number;                 // Normal X
  ny?: number;                 // Normal Y
  nz?: number;                 // Normal Z
  confidence?: number;         // 0-1
}

/**
 * Result of dense reconstruction
 */
export interface PointCloudResult {
  points: DensePoint3D[];
  totalPoints: number;
  bounds: BoundingBox3D;
  
  // Files
  plyFile?: string;            // Path to PLY file on server
  streamingEndpoint?: string;  // URL for chunked streaming
  
  // Statistics
  density: number;             // Points per cubic meter
  processingTime: number;
}

// =============================================================================
// MESH TYPES
// =============================================================================

/**
 * Triangle mesh
 */
export interface MeshData {
  vertices: Float32Array;      // Flat [x,y,z, x,y,z, ...]
  faces: Uint32Array;          // Triangle indices [i,j,k, i,j,k, ...]
  normals?: Float32Array;      // Per-vertex normals
  uvs?: Float32Array;          // Texture coordinates [u,v, u,v, ...]
  colors?: Uint8Array;         // Per-vertex colors [r,g,b, r,g,b, ...]
}

/**
 * Texture atlas for mesh
 */
export interface TextureAtlas {
  imageUrl: string;            // URL to texture image
  width: number;
  height: number;
  format: 'jpg' | 'png' | 'webp';
}

/**
 * Result of mesh generation
 */
export interface MeshResult {
  // Mesh data
  mesh: MeshData;
  texture?: TextureAtlas;
  
  // Statistics
  numVertices: number;
  numFaces: number;
  surfaceArea: number;         // Square meters
  volume: number;              // Cubic meters
  bounds: BoundingBox3D;
  
  // Quality levels
  files: {
    full?: string;             // Full resolution PLY/OBJ
    webGlb?: string;           // Optimized GLB for web
    webGlbDraco?: string;      // DRACO-compressed GLB
    preview?: string;          // Low-poly preview
  };
  
  // Processing
  processingTime: number;
  method: 'poisson' | 'ball_pivoting' | 'delaunay';
}

// =============================================================================
// NAVIGATION TYPES
// =============================================================================

/**
 * Viewpoint for virtual walkthrough
 */
export interface Viewpoint {
  id: string;
  position: Vector3;
  rotation: Quaternion;
  lookDirection: Vector3;      // Direction camera is facing
  
  // Display
  label?: string;
  thumbnailUrl?: string;
  originalPhotoUrl?: string;   // Original captured photo from this viewpoint
  
  // Metadata
  isClusterCenter: boolean;
  clusterId: string;
  photoIds: string[];          // Photos in this viewpoint's cluster
}

/**
 * Connection between two viewpoints
 */
export interface NavigationEdge {
  from: string;                // Viewpoint ID
  to: string;                  // Viewpoint ID
  distance: number;            // Meters
  direction: number;           // Azimuth from 'from' to 'to'
  obstructed: boolean;         // Is there geometry in the way?
  walkable: boolean;           // Can user naturally walk this path?
}

/**
 * Complete navigation graph
 */
export interface NavigationGraph {
  viewpoints: Viewpoint[];
  edges: NavigationEdge[];
  
  // For quick lookup
  viewpointMap: Map<string, Viewpoint>;
  adjacencyList: Map<string, string[]>; // viewpointId -> connected viewpoint IDs
}

/**
 * Result of navigation generation
 */
export interface NavigationResult {
  graph: NavigationGraph;
  
  // Summary
  numViewpoints: number;
  numEdges: number;
  averageConnections: number;
  
  // Recommendations
  suggestedStartViewpoint: string;
  tourPath?: string[];         // Suggested order to visit viewpoints
}

// =============================================================================
// MEASUREMENT TYPES
// =============================================================================

/**
 * Point on mesh surface (from raycast)
 */
export interface SurfacePoint {
  position: Vector3;
  normal: Vector3;
  faceIndex: number;
  barycentricCoords: Vector3;
  distance: number;            // Distance from camera
}

/**
 * Distance measurement between two points
 */
export interface DistanceMeasurement {
  id: string;
  start: SurfacePoint;
  end: SurfacePoint;
  distance: number;            // Meters
  distanceFeet: number;
  distanceInches: number;
  type: 'straight' | 'geodesic'; // Straight line or along surface
}

/**
 * Area measurement (polygon on surface)
 */
export interface AreaMeasurement {
  id: string;
  points: SurfacePoint[];
  areaSqMeters: number;
  areaSqFeet: number;
}

/**
 * Room dimensions extracted from mesh
 */
export interface RoomDimensionsFromMesh {
  width: number;               // Meters
  length: number;
  height: number;
  widthFeet: number;
  lengthFeet: number;
  heightFeet: number;
  floorArea: number;           // Square meters
  floorAreaSqFt: number;
  volume: number;              // Cubic meters
  volumeCuFt: number;
  
  // Detected surfaces
  floor?: DetectedPlane;
  ceiling?: DetectedPlane;
  walls?: DetectedPlane[];
  
  confidence: number;
}

export interface DetectedPlane {
  normal: Vector3;
  distance: number;            // Distance from origin
  area: number;                // Square meters
  bounds: BoundingBox3D;
  vertices: Vector3[];         // Corner points
}

// =============================================================================
// OBJECT ISOLATION TYPES
// =============================================================================

/**
 * Selected region of mesh for isolation/export
 */
export interface MeshSelection {
  id: string;
  name: string;
  faceIndices: number[];
  vertexIndices: number[];
  bounds: BoundingBox3D;
  
  // Isolated mesh data (after extraction)
  isolatedMesh?: MeshData;
  isolatedTexture?: TextureAtlas;
  exportFiles?: {
    glb?: string;
    obj?: string;
    stl?: string;
  };
}

/**
 * Segmentation result from AI
 */
export interface SegmentationMask {
  id: string;
  label: string;
  confidence: number;
  mask: Uint8Array;            // Binary mask
  bounds: { x: number; y: number; width: number; height: number };
}

// =============================================================================
// API TYPES
// =============================================================================

/**
 * Request to start photogrammetry processing
 */
export interface ProcessingRequest {
  scanId: string;
  options: ProcessingOptions;
}

export interface ProcessingOptions {
  // Pipeline selection
  pipelineVersion?: 'v1' | 'v2' | 'hybrid_v1' | 'master_v1';

  // Feature extraction
  featureType: 'sift' | 'superpoint';
  maxFeatures: number;
  
  // Matching
  matchingStrategy: 'exhaustive' | 'sequential' | 'vocabulary_tree';
  
  // Dense reconstruction
  denseMethod: 'colmap' | 'depth_ai' | 'hybrid';
  depthModel?: 'zoedepth' | 'depth_anything_v2' | 'metric3d';
  
  // Depth priors (for featureless surfaces - walls, floors, ceilings)
  useDepthPriors: boolean;      // Enable AI depth priors for MVS initialization
  depthPriorModel: 'depth_anything_v2';  // AI model for depth estimation
  
  // Mesh generation
  meshMethod: 'poisson' | 'ball_pivoting' | 'delaunay';
  meshDepth: number;           // Poisson depth (9-12)
  targetTriangles?: number;    // For decimation
  
  // Texture
  textureResolution: 2048 | 4096 | 8192;
  textureFormat: 'jpg' | 'png';
  
  // Export
  exportFormats: ('glb' | 'obj' | 'ply' | 'fbx' | 'usdz')[];
  
  // Navigation
  generateNavigation: boolean;
  clusterRadius: number;       // Meters, for viewpoint clustering

  // GPU worker settings
  gpuCount?: number;
  cudaVisibleDevices?: string;
}

export const DEFAULT_PROCESSING_OPTIONS: ProcessingOptions = {
  featureType: 'sift',
  maxFeatures: 3000,
  matchingStrategy: 'exhaustive',
  denseMethod: 'hybrid',
  depthModel: 'depth_anything_v2',
  useDepthPriors: true,        // Enable by default for better wall/floor coverage
  depthPriorModel: 'depth_anything_v2',
  meshMethod: 'poisson',
  meshDepth: 10,
  targetTriangles: 500000,
  textureResolution: 4096,
  textureFormat: 'jpg',
  exportFormats: ['glb'],
  generateNavigation: true,
  clusterRadius: 0.5,
};

/**
 * Processing status update (for websocket/polling)
 */
export interface ProcessingStatusUpdate {
  scanId: string;
  status: PhotogrammetryStatus;
  progress: ProcessingProgress;
  result?: Partial<PhotogrammetryScan>;
  error?: string;
}

/**
 * Upload progress callback
 */
export interface UploadProgress {
  phase: 'preparing' | 'uploading' | 'finalizing';
  photosUploaded: number;
  totalPhotos: number;
  bytesUploaded: number;
  totalBytes: number;
  percent: number;
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Create empty coverage grid with specified cell size
 */
export function createCoverageGrid(cellSizeDegrees: number = 10): CoverageGrid {
  const numAzimuth = Math.ceil(360 / cellSizeDegrees);
  const numElevation = Math.ceil(180 / cellSizeDegrees);
  
  const cells: CoverageCell[][] = [];
  
  for (let a = 0; a < numAzimuth; a++) {
    cells[a] = [];
    for (let e = 0; e < numElevation; e++) {
      cells[a][e] = {
        azimuth: a * cellSizeDegrees + cellSizeDegrees / 2,
        elevation: e * cellSizeDegrees - 90 + cellSizeDegrees / 2,
        cellWidth: cellSizeDegrees,
        cellHeight: cellSizeDegrees,
        viewCount: 0,
        positionIds: [],
        photoIds: [],
        triangulatable: false,
        averageDistance: 0,
        confidence: 0,
      };
    }
  }
  
  return {
    cellSize: cellSizeDegrees,
    cells,
    overallCoverage: 0,
    triangulatableCoverage: 0,
    largestGap: 360,
    gapLocations: [],
  };
}

/**
 * Create empty floor grid
 */
export function createFloorGrid(cellSizeMeters: number = 0.5): FloorGrid {
  return {
    cellSize: cellSizeMeters,
    cells: new Map(),
    bounds: {
      min: { x: Infinity, y: Infinity, z: Infinity },
      max: { x: -Infinity, y: -Infinity, z: -Infinity },
      center: { x: 0, y: 0, z: 0 },
      size: { x: 0, y: 0, z: 0 },
    },
  };
}

/**
 * Generate unique ID
 */
export function generateId(): string {
  return `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Vector3 math utilities
 */
export const Vec3 = {
  create: (x = 0, y = 0, z = 0): Vector3 => ({ x, y, z }),
  
  add: (a: Vector3, b: Vector3): Vector3 => ({
    x: a.x + b.x,
    y: a.y + b.y,
    z: a.z + b.z,
  }),
  
  subtract: (a: Vector3, b: Vector3): Vector3 => ({
    x: a.x - b.x,
    y: a.y - b.y,
    z: a.z - b.z,
  }),
  
  scale: (v: Vector3, s: number): Vector3 => ({
    x: v.x * s,
    y: v.y * s,
    z: v.z * s,
  }),
  
  length: (v: Vector3): number => 
    Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z),
  
  distance: (a: Vector3, b: Vector3): number =>
    Vec3.length(Vec3.subtract(a, b)),
  
  normalize: (v: Vector3): Vector3 => {
    const len = Vec3.length(v);
    return len > 0 ? Vec3.scale(v, 1 / len) : { x: 0, y: 0, z: 0 };
  },
  
  dot: (a: Vector3, b: Vector3): number =>
    a.x * b.x + a.y * b.y + a.z * b.z,
  
  cross: (a: Vector3, b: Vector3): Vector3 => ({
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  }),
};

/**
 * Quaternion utilities
 */
export const Quat = {
  identity: (): Quaternion => ({ x: 0, y: 0, z: 0, w: 1 }),
  
  fromEuler: (roll: number, pitch: number, yaw: number): Quaternion => {
    const cy = Math.cos(yaw * 0.5);
    const sy = Math.sin(yaw * 0.5);
    const cp = Math.cos(pitch * 0.5);
    const sp = Math.sin(pitch * 0.5);
    const cr = Math.cos(roll * 0.5);
    const sr = Math.sin(roll * 0.5);
    
    return {
      w: cr * cp * cy + sr * sp * sy,
      x: sr * cp * cy - cr * sp * sy,
      y: cr * sp * cy + sr * cp * sy,
      z: cr * cp * sy - sr * sp * cy,
    };
  },
  
  toEuler: (q: Quaternion): { roll: number; pitch: number; yaw: number } => {
    const sinr_cosp = 2 * (q.w * q.x + q.y * q.z);
    const cosr_cosp = 1 - 2 * (q.x * q.x + q.y * q.y);
    const roll = Math.atan2(sinr_cosp, cosr_cosp);
    
    const sinp = 2 * (q.w * q.y - q.z * q.x);
    const pitch = Math.abs(sinp) >= 1 
      ? Math.sign(sinp) * Math.PI / 2 
      : Math.asin(sinp);
    
    const siny_cosp = 2 * (q.w * q.z + q.x * q.y);
    const cosy_cosp = 1 - 2 * (q.y * q.y + q.z * q.z);
    const yaw = Math.atan2(siny_cosp, cosy_cosp);
    
    return { roll, pitch, yaw };
  },
  
  multiply: (a: Quaternion, b: Quaternion): Quaternion => ({
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  }),
  
  angleBetween: (a: Quaternion, b: Quaternion): number => {
    const dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
    return 2 * Math.acos(Math.min(1, Math.abs(dot)));
  },
};

/**
 * Convert degrees to radians
 */
export function degToRad(degrees: number): number {
  return degrees * (Math.PI / 180);
}

/**
 * Convert radians to degrees
 */
export function radToDeg(radians: number): number {
  return radians * (180 / Math.PI);
}

/**
 * Normalize angle to 0-360 range
 */
export function normalizeAngle(angle: number): number {
  angle = angle % 360;
  return angle < 0 ? angle + 360 : angle;
}

/**
 * Get angular distance between two azimuths (shortest path)
 */
export function angularDistance(a: number, b: number): number {
  const diff = Math.abs(normalizeAngle(a) - normalizeAngle(b));
  return Math.min(diff, 360 - diff);
}
