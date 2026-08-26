/**
 * Panorama Scanner Types
 * Enhanced types for 26-photo spherical capture with complete coverage
 * Includes iPhone sensor data for accurate photogrammetry
 */

import { DepthMapResult } from './roomScanner';

// Full iPhone sensor data for accurate camera pose estimation
export interface iPhoneSensorData {
  // Core Motion (CMDeviceMotion) - 100Hz update rate
  attitude: {
    roll: number;      // Rotation around longitudinal axis (radians)
    pitch: number;     // Rotation around lateral axis (radians)
    yaw: number;       // Rotation around vertical axis (radians)
    quaternion: { x: number; y: number; z: number; w: number };  // More stable for 3D
  };
  
  // User acceleration (without gravity)
  userAcceleration: { x: number; y: number; z: number };  // m/s²
  
  // Gravity vector in device frame
  gravity: { x: number; y: number; z: number };  // Normalized (-1 to 1)
  
  // Rotation rate from gyroscope
  rotationRate: {
    x: number;  // rad/s around X
    y: number;  // rad/s around Y
    z: number;  // rad/s around Z
  };
  
  // Magnetic field (for compass heading)
  magneticField: {
    x: number;  // µT (microtesla)
    y: number;
    z: number;
    accuracy: 'uncalibrated' | 'low' | 'medium' | 'high';
  };
  
  // Heading relative to magnetic/true north
  heading: {
    magneticHeading: number;  // 0-360°
    trueHeading: number;      // 0-360° (requires location)
    headingAccuracy: number;  // Degrees of error
  };
  
  timestamp: number;  // High-precision timestamp
}

// Camera intrinsics from iPhone (if available via ARKit-like APIs)
export interface CameraIntrinsics {
  focalLengthX: number;      // Focal length in pixels (horizontal)
  focalLengthY: number;      // Focal length in pixels (vertical)
  principalPointX: number;   // Principal point X (usually width/2)
  principalPointY: number;   // Principal point Y (usually height/2)
  imageWidth: number;
  imageHeight: number;
  // Lens distortion coefficients (Brown-Conrady model)
  distortion?: {
    k1: number;  // Radial distortion
    k2: number;
    k3: number;
    p1: number;  // Tangential distortion
    p2: number;
  };
}

// Enhanced photo with spherical coordinates and full sensor data
export interface PanoramaPhoto {
  azimuth: number;        // 0-360° horizontal rotation (compass direction)
  elevation: number;      // -90° to +90° vertical angle (-90=nadir, 0=horizon, +90=zenith)
  ringIndex: number;      // 0-6, which ring in the pattern
  photoIndex: number;     // Position within the ring (0 to ring.photos-1)
  imageData: string;      // Base64 encoded image
  timestamp: number;
  depthMap?: DepthMapResult;
  type: 'zenith' | 'ring' | 'nadir';
  
  // Anchor-relative orientation for accurate stitching
  actualAzimuth?: number;   // Actual relative azimuth when photo was taken (relative to anchor)
  anchorAlpha?: number;     // Anchor compass heading used as reference point
  
  // Enhanced sensor data for photogrammetry
  sensorData?: iPhoneSensorData;
  cameraIntrinsics?: CameraIntrinsics;
  
  // Computed camera pose from sensor fusion
  cameraPose?: CameraPose;
}

// Full 6-DOF camera pose (position + orientation)
export interface CameraPose {
  // Position in world coordinates (meters)
  position: { x: number; y: number; z: number };
  
  // Orientation as quaternion (most stable for interpolation)
  rotation: { x: number; y: number; z: number; w: number };
  
  // Rotation matrix (3x3) for direct transformations
  rotationMatrix: number[][];  // 3x3
  
  // Confidence/accuracy of the pose estimate
  confidence: number;  // 0-1
  
  // Source of the pose (sensor-only, visual, fused)
  source: 'imu' | 'visual' | 'fused' | 'manual';
}

// Capture ring definition
export interface CaptureRing {
  elevation: number;      // Vertical angle for this ring
  photos: number;         // Number of photos in this ring
  spacing: number;        // Degrees between photos (360/photos)
  type: 'zenith' | 'ring' | 'nadir';
}

// Complete capture pattern
export interface CapturePattern {
  rings: CaptureRing[];
  totalPhotos: number;
}

// Capture instruction for user
export interface CaptureInstruction {
  ringIndex: number;
  photoIndex: number;
  azimuth: number;
  elevation: number;
  instruction: string;
  type: 'zenith' | 'ring' | 'nadir';
}

// 3D point with color (supports both direct x,y,z and nested position)
export interface Point3D {
  x: number;
  y: number;
  z: number;
  r?: number;  // Color (0-255)
  g?: number;
  b?: number;
  position?: { x: number; y: number; z: number };  // Alternative nested format
  color?: { r: number; g: number; b: number };
  normal?: { x: number; y: number; z: number };
}

// Camera parameters
export interface CameraParams {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
  fov: number;
  aspect: number;
}

// Photo with 3D data
export interface Photo3D {
  photo: PanoramaPhoto;
  points3D: Point3D[];
  camera: CameraParams;
}

// 3D Mesh
export interface Mesh3D {
  vertices: number[];     // Flat array of vertex positions [x,y,z, x,y,z, ...]
  faces: number[];        // Triangle indices [i1,i2,i3, i1,i2,i3, ...]
  uvs: number[];          // Texture coordinates [u,v, u,v, ...]
  normals: number[];      // Normal vectors [x,y,z, x,y,z, ...]
  textureUrl?: string;    // URL to texture image
}

// Room dimensions
export interface RoomDimensions {
  width: number;          // Meters
  widthMeters: number;    // Explicit meters
  widthFeet: number;      // Feet
  length: number;         // Meters
  lengthMeters: number;   // Explicit meters
  lengthFeet: number;     // Feet
  height: number;         // Meters
  heightMeters: number;   // Explicit meters
  heightFeet: number;     // Feet
  volume: number;         // Cubic meters
  floorArea: number;      // Square meters
  floorAreaSqM: number;   // Explicit square meters
  floorAreaSqFt: number;  // Square feet
  confidence: number;     // 0-1
  measurements: RoomSurface[];
}

// Detected room surface (wall, floor, ceiling)
export interface RoomSurface {
  type: 'floor' | 'ceiling' | 'wall' | 'unknown';
  plane: {
    normal: { x: number; y: number; z: number };
    distance: number;
  };
  vertices: Array<{ x: number; y: number; z: number }>;
  area: number;           // Square meters
  pointCount: number;
}

// Stitched depth panorama with metadata for room measurements
export interface DepthPanoramaResult {
  data: string;                 // Base64 16-bit PNG depth map
  width: number;
  height: number;
  minDepth: number;             // Minimum depth in meters
  maxDepth: number;             // Maximum depth in meters
  meanDepth: number;            // Average depth in meters
  medianDepth: number;          // Median depth in meters
  coverage: number;             // Percentage of panorama with valid depth (0-100)
}

// Complete stitched panorama result
export interface StitchedPanorama {
  equirectangular: string;      // Base64 4096×2048 stitched panorama
  depthPanorama?: DepthPanoramaResult;  // Stitched depth with metrics
  pointCloud: Point3D[];        // Merged 3D points from all views
  pointCloudFile?: string;      // Filename for chunked point cloud loading (e.g., "pointcloud_12345.json")
  mesh?: Mesh3D;                // Textured 3D mesh
  roomDimensions: RoomDimensions;
  stitchQuality: number;        // 0-1, quality metric
  seamLocations?: number[];     // Azimuth angles where seams occurred
  processingTime: number;       // Seconds
}

// Keypoint for feature detection
export interface Keypoint {
  x: number;
  y: number;
  scale: number;
  angle: number;                // Dominant orientation 0-360°
  response: number;             // Corner strength
  descriptor: Uint8Array;       // 256-bit binary descriptor
}

// Feature match between two images
export interface Match {
  queryIdx: number;             // Index in first image's keypoints
  trainIdx: number;             // Index in second image's keypoints
  distance: number;             // Descriptor distance (lower = better)
  point1: { x: number; y: number };
  point2: { x: number; y: number };
  depth3DConsistent?: boolean;  // Valid according to 3D geometry
  distance3D?: number;          // 3D distance in meters
}

// Homography result from RANSAC
export interface HomographyResult {
  H: number[][];                // 3x3 transformation matrix
  inliers: Match[];             // Good matches
  outliers: Match[];            // Bad matches (rejected)
  inlierRatio: number;          // Percentage of inliers
}

// Stitching progress
export interface StitchingProgress {
  phase: 'detecting' | 'matching' | 'warping' | 'blending' | 'projecting' | 'complete';
  currentRing?: number;
  currentPhoto?: number;
  totalPhotos: number;
  message: string;
  percent: number;
}

// 26-photo capture pattern (complete spherical coverage)
// Reordered to start with horizon so first photo can be any wall
export const CAPTURE_PATTERN_26: CapturePattern = {
  rings: [
    { elevation: 0,   photos: 12, spacing: 30,  type: 'ring' },     // Horizon (START HERE - any wall)
    { elevation: 30,  photos: 4,  spacing: 90,  type: 'ring' },     // Mid-upper ring
    { elevation: 60,  photos: 4,  spacing: 90,  type: 'ring' },     // Upper ring
    { elevation: 90,  photos: 1,  spacing: 0,   type: 'zenith' },   // Straight up
    { elevation: -30, photos: 4,  spacing: 90,  type: 'ring' },     // Mid-lower ring
    { elevation: -60, photos: 4,  spacing: 90,  type: 'ring' },     // Lower ring
    { elevation: -90, photos: 1,  spacing: 0,   type: 'nadir' }     // Straight down
  ],
  totalPhotos: 30
};

// Alternative 20-photo pattern (faster, still good coverage)
export const CAPTURE_PATTERN_20: CapturePattern = {
  rings: [
    { elevation: 90,  photos: 1,  spacing: 0,   type: 'zenith' },
    { elevation: 45,  photos: 6,  spacing: 60,  type: 'ring' },
    { elevation: 0,   photos: 12, spacing: 30,  type: 'ring' },
    { elevation: -45, photos: 6,  spacing: 60,  type: 'ring' },
    { elevation: -90, photos: 1,  spacing: 0,   type: 'nadir' }
  ],
  totalPhotos: 20
};

// Generate capture sequence from pattern
export function generateCaptureSequence(pattern: CapturePattern): CaptureInstruction[] {
  const sequence: CaptureInstruction[] = [];
  
  for (let ringIdx = 0; ringIdx < pattern.rings.length; ringIdx++) {
    const ring = pattern.rings[ringIdx];
    
    for (let photoIdx = 0; photoIdx < ring.photos; photoIdx++) {
      const azimuth = ring.photos > 1 ? (photoIdx * ring.spacing) % 360 : 0;
      
      sequence.push({
        ringIndex: ringIdx,
        photoIndex: photoIdx,
        azimuth,
        elevation: ring.elevation,
        instruction: getInstructionText(ring.elevation, azimuth, photoIdx, ring.photos),
        type: ring.type
      });
    }
  }
  
  return sequence;
}

// Generate instruction text for user
function getInstructionText(
  elevation: number,
  azimuth: number,
  photoIdx: number,
  totalInRing: number
): string {
  if (elevation === 90) {
    return "📸 Point camera straight up at ceiling center";
  } else if (elevation === -90) {
    return "📸 Point camera straight down at floor center";
  } else if (elevation > 0) {
    const elevText = elevation === 60 ? "60° UP" : elevation === 45 ? "45° UP" : `${elevation}° UP`;
    if (totalInRing === 1) {
      return `📸 Tilt camera ${elevText}`;
    }
    return `📸 Tilt ${elevText}, rotate to ${azimuth}° (photo ${photoIdx + 1}/${totalInRing})`;
  } else if (elevation < 0) {
    const elevText = elevation === -60 ? "60° DOWN" : elevation === -45 ? "45° DOWN" : `${Math.abs(elevation)}° DOWN`;
    if (totalInRing === 1) {
      return `📸 Tilt camera ${elevText}`;
    }
    return `📸 Tilt ${elevText}, rotate to ${azimuth}° (photo ${photoIdx + 1}/${totalInRing})`;
  } else {
    return `📸 Hold camera level, rotate to ${azimuth}° (photo ${photoIdx + 1}/${totalInRing})`;
  }
}

// Estimate camera parameters from photo metadata
export function estimateCameraParams(photo: PanoramaPhoto): CameraParams {
  // Convert spherical coordinates to camera position/rotation
  const azimuthRad = (photo.azimuth * Math.PI) / 180;
  const elevationRad = (photo.elevation * Math.PI) / 180;
  
  return {
    position: { x: 0, y: 0, z: 0 }, // Camera at center
    rotation: {
      x: elevationRad,
      y: azimuthRad,
      z: 0
    },
    fov: 75, // Typical smartphone camera FOV
    aspect: 16 / 9
  };
}
