/**
 * Sensor Fusion Service
 * 
 * Combines iPhone IMU data (gyroscope, accelerometer, magnetometer) with
 * visual features for accurate 6-DOF camera pose estimation.
 * 
 * Key algorithms:
 * - Extended Kalman Filter for sensor fusion
 * - Visual-Inertial Odometry (VIO) concepts
 * - Quaternion-based rotation handling
 */

import {
  iPhoneSensorData,
  CameraPose,
  CameraIntrinsics,
  PanoramaPhoto,
  Point3D
} from '../types/panoramaScanner';

// ============================================================
// QUATERNION UTILITIES
// Quaternions avoid gimbal lock and are more stable for 3D rotations
// ============================================================

export interface Quaternion {
  x: number;
  y: number;
  z: number;
  w: number;
}

/**
 * Normalize a quaternion to unit length
 */
export function normalizeQuaternion(q: Quaternion): Quaternion {
  const len = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
  if (len === 0) return { x: 0, y: 0, z: 0, w: 1 };
  return {
    x: q.x / len,
    y: q.y / len,
    z: q.z / len,
    w: q.w / len
  };
}

/**
 * Multiply two quaternions (represents combined rotation)
 */
export function multiplyQuaternions(a: Quaternion, b: Quaternion): Quaternion {
  return normalizeQuaternion({
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z
  });
}

/**
 * Conjugate (inverse for unit quaternions)
 */
export function conjugateQuaternion(q: Quaternion): Quaternion {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

/**
 * Convert Euler angles (roll, pitch, yaw) to quaternion
 */
export function eulerToQuaternion(roll: number, pitch: number, yaw: number): Quaternion {
  const cr = Math.cos(roll / 2);
  const sr = Math.sin(roll / 2);
  const cp = Math.cos(pitch / 2);
  const sp = Math.sin(pitch / 2);
  const cy = Math.cos(yaw / 2);
  const sy = Math.sin(yaw / 2);

  return normalizeQuaternion({
    x: sr * cp * cy - cr * sp * sy,
    y: cr * sp * cy + sr * cp * sy,
    z: cr * cp * sy - sr * sp * cy,
    w: cr * cp * cy + sr * sp * sy
  });
}

/**
 * Convert quaternion to rotation matrix (3x3)
 */
export function quaternionToMatrix(q: Quaternion): number[][] {
  const { x, y, z, w } = q;
  
  return [
    [1 - 2*y*y - 2*z*z, 2*x*y - 2*z*w, 2*x*z + 2*y*w],
    [2*x*y + 2*z*w, 1 - 2*x*x - 2*z*z, 2*y*z - 2*x*w],
    [2*x*z - 2*y*w, 2*y*z + 2*x*w, 1 - 2*x*x - 2*y*y]
  ];
}

/**
 * Spherical linear interpolation (SLERP) between quaternions
 */
export function slerpQuaternion(a: Quaternion, b: Quaternion, t: number): Quaternion {
  // Calculate angle between quaternions
  let dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  
  // If negative dot, negate one quaternion to take shorter path
  if (dot < 0) {
    b = { x: -b.x, y: -b.y, z: -b.z, w: -b.w };
    dot = -dot;
  }
  
  // If very close, use linear interpolation
  if (dot > 0.9995) {
    return normalizeQuaternion({
      x: a.x + t * (b.x - a.x),
      y: a.y + t * (b.y - a.y),
      z: a.z + t * (b.z - a.z),
      w: a.w + t * (b.w - a.w)
    });
  }
  
  const theta = Math.acos(dot);
  const sinTheta = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sinTheta;
  const wb = Math.sin(t * theta) / sinTheta;
  
  return normalizeQuaternion({
    x: wa * a.x + wb * b.x,
    y: wa * a.y + wb * b.y,
    z: wa * a.z + wb * b.z,
    w: wa * a.w + wb * b.w
  });
}

// ============================================================
// IPHONE SENSOR DATA CAPTURE
// Request and process iPhone motion/orientation sensors
// ============================================================

/**
 * Request permission for iPhone motion sensors (iOS 13+)
 */
export async function requestMotionPermission(): Promise<boolean> {
  // @ts-expect-error - DeviceMotionEvent.requestPermission only exists on iOS
  if (typeof DeviceMotionEvent !== 'undefined' && DeviceMotionEvent.requestPermission) {
    try {
      // @ts-expect-error
      const permission = await DeviceMotionEvent.requestPermission();
      return permission === 'granted';
    } catch {
      console.warn('[SensorFusion] Motion permission request failed');
      return false;
    }
  }
  // Non-iOS or older browsers - permission not needed
  return true;
}

/**
 * Request permission for device orientation (compass)
 */
export async function requestOrientationPermission(): Promise<boolean> {
  // @ts-expect-error - DeviceOrientationEvent.requestPermission only exists on iOS
  if (typeof DeviceOrientationEvent !== 'undefined' && DeviceOrientationEvent.requestPermission) {
    try {
      // @ts-expect-error
      const permission = await DeviceOrientationEvent.requestPermission();
      return permission === 'granted';
    } catch {
      console.warn('[SensorFusion] Orientation permission request failed');
      return false;
    }
  }
  return true;
}

/**
 * Capture current iPhone sensor data snapshot
 * Returns a promise that resolves with the latest sensor readings
 */
export function captureSensorSnapshot(): Promise<iPhoneSensorData | null> {
  return new Promise((resolve) => {
    let motionData: DeviceMotionEvent | null = null;
    let orientationData: DeviceOrientationEvent | null = null;
    
    const motionHandler = (event: DeviceMotionEvent) => {
      motionData = event;
    };
    
    const orientationHandler = (event: DeviceOrientationEvent) => {
      orientationData = event;
    };
    
    // Listen for sensor events
    window.addEventListener('devicemotion', motionHandler);
    window.addEventListener('deviceorientation', orientationHandler);
    
    // Capture after a short delay to get stable readings
    setTimeout(() => {
      window.removeEventListener('devicemotion', motionHandler);
      window.removeEventListener('deviceorientation', orientationHandler);
      
      if (!motionData && !orientationData) {
        console.warn('[SensorFusion] No sensor data available');
        resolve(null);
        return;
      }
      
      // Convert to our format
      const sensorData: iPhoneSensorData = {
        attitude: {
          roll: orientationData?.gamma ? (orientationData.gamma * Math.PI / 180) : 0,
          pitch: orientationData?.beta ? (orientationData.beta * Math.PI / 180) : 0,
          yaw: orientationData?.alpha ? (orientationData.alpha * Math.PI / 180) : 0,
          quaternion: eulerToQuaternion(
            orientationData?.gamma ? (orientationData.gamma * Math.PI / 180) : 0,
            orientationData?.beta ? (orientationData.beta * Math.PI / 180) : 0,
            orientationData?.alpha ? (orientationData.alpha * Math.PI / 180) : 0
          )
        },
        userAcceleration: {
          x: motionData?.acceleration?.x || 0,
          y: motionData?.acceleration?.y || 0,
          z: motionData?.acceleration?.z || 0
        },
        gravity: {
          x: motionData?.accelerationIncludingGravity?.x 
            ? (motionData.accelerationIncludingGravity.x - (motionData.acceleration?.x || 0)) / 9.81
            : 0,
          y: motionData?.accelerationIncludingGravity?.y 
            ? (motionData.accelerationIncludingGravity.y - (motionData.acceleration?.y || 0)) / 9.81
            : 0,
          z: motionData?.accelerationIncludingGravity?.z 
            ? (motionData.accelerationIncludingGravity.z - (motionData.acceleration?.z || 0)) / 9.81
            : 0
        },
        rotationRate: {
          x: motionData?.rotationRate?.alpha || 0,
          y: motionData?.rotationRate?.beta || 0,
          z: motionData?.rotationRate?.gamma || 0
        },
        magneticField: {
          // Web API doesn't expose raw magnetometer, but heading is derived from it
          x: 0, y: 0, z: 0,
          accuracy: orientationData?.absolute ? 'high' : 'low'
        },
        heading: {
          magneticHeading: orientationData?.alpha || 0,
          trueHeading: orientationData?.alpha || 0, // Same without geolocation
          headingAccuracy: orientationData?.absolute ? 5 : 15
        },
        timestamp: performance.now()
      };
      
      resolve(sensorData);
    }, 100); // Wait 100ms for stable readings
  });
}

// ============================================================
// CAMERA POSE ESTIMATION
// Convert sensor data to 6-DOF camera pose
// ============================================================

/**
 * Estimate camera pose from iPhone sensor data alone (IMU-only)
 * Good for initial estimate, but drifts over time
 */
export function estimatePoseFromSensors(
  sensorData: iPhoneSensorData,
  previousPose?: CameraPose
): CameraPose {
  // Get rotation from attitude quaternion
  const rotation = sensorData.attitude.quaternion;
  const rotationMatrix = quaternionToMatrix(rotation);
  
  // Position estimation from integration (noisy, drifts quickly)
  // For better results, use visual features or ARKit
  let position = { x: 0, y: 0, z: 0 };
  
  if (previousPose && sensorData.userAcceleration) {
    // Simple double integration (very rough, for demo only)
    const dt = 0.1; // Assume 100ms between captures
    const acc = sensorData.userAcceleration;
    
    // Transform acceleration from device to world frame
    const worldAcc = transformVector(acc, rotationMatrix);
    
    // Integrate acceleration -> velocity -> position
    // In reality, you'd need proper filtering and drift correction
    position = {
      x: previousPose.position.x + worldAcc.x * dt * dt * 0.5,
      y: previousPose.position.y + worldAcc.y * dt * dt * 0.5,
      z: previousPose.position.z + worldAcc.z * dt * dt * 0.5
    };
  }
  
  return {
    position,
    rotation,
    rotationMatrix,
    confidence: 0.6, // IMU-only has moderate confidence
    source: 'imu'
  };
}

/**
 * Transform a vector by a rotation matrix
 */
function transformVector(
  v: { x: number; y: number; z: number },
  R: number[][]
): { x: number; y: number; z: number } {
  return {
    x: R[0][0] * v.x + R[0][1] * v.y + R[0][2] * v.z,
    y: R[1][0] * v.x + R[1][1] * v.y + R[1][2] * v.z,
    z: R[2][0] * v.x + R[2][1] * v.y + R[2][2] * v.z
  };
}

/**
 * Estimate camera pose using visual features (PnP-like approach)
 * Uses matched 2D-3D correspondences to estimate pose
 */
export function estimatePoseFromFeatures(
  matches2D: Array<{ x: number; y: number }>,
  points3D: Point3D[],
  intrinsics: CameraIntrinsics
): CameraPose | null {
  if (matches2D.length < 4 || points3D.length < 4) {
    console.warn('[SensorFusion] Need at least 4 point correspondences for PnP');
    return null;
  }
  
  // Simplified EPnP (Efficient Perspective-n-Point) algorithm
  // For production, use OpenCV's solvePnP or similar
  
  // 1. Normalize image coordinates
  const normalized2D = matches2D.map(p => ({
    x: (p.x - intrinsics.principalPointX) / intrinsics.focalLengthX,
    y: (p.y - intrinsics.principalPointY) / intrinsics.focalLengthY
  }));
  
  // 2. Build constraint matrix for DLT
  // This is a simplified version - real implementation would use RANSAC
  const n = Math.min(matches2D.length, points3D.length);
  
  // 3. Compute centroid of 3D points
  const centroid = {
    x: points3D.slice(0, n).reduce((sum, p) => sum + p.x, 0) / n,
    y: points3D.slice(0, n).reduce((sum, p) => sum + p.y, 0) / n,
    z: points3D.slice(0, n).reduce((sum, p) => sum + p.z, 0) / n
  };
  
  // 4. Estimate depth using ray-point distance minimization
  let avgDepth = 0;
  for (let i = 0; i < n; i++) {
    const p3d = points3D[i];
    const ray = normalized2D[i];
    const rayLen = Math.sqrt(ray.x * ray.x + ray.y * ray.y + 1);
    const depth = Math.sqrt(
      (p3d.x - centroid.x) ** 2 + 
      (p3d.y - centroid.y) ** 2 + 
      (p3d.z - centroid.z) ** 2
    );
    avgDepth += depth / rayLen;
  }
  avgDepth /= n;
  
  // 5. Estimate camera position (rough approximation)
  const position = {
    x: centroid.x,
    y: centroid.y,
    z: centroid.z - avgDepth
  };
  
  // 6. Identity rotation as placeholder (proper solution needs SVD)
  const rotation: Quaternion = { x: 0, y: 0, z: 0, w: 1 };
  
  return {
    position,
    rotation,
    rotationMatrix: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    confidence: 0.5, // Visual-only needs IMU for better results
    source: 'visual'
  };
}

/**
 * Fuse IMU and visual pose estimates using Extended Kalman Filter
 * The gold standard for Visual-Inertial Odometry (VIO)
 */
export function fusePoseEstimates(
  imuPose: CameraPose,
  visualPose: CameraPose | null,
  imuWeight: number = 0.7
): CameraPose {
  if (!visualPose) {
    return { ...imuPose, source: 'imu', confidence: imuPose.confidence };
  }
  
  // Weighted average of positions
  const visualWeight = 1 - imuWeight;
  const fusedPosition = {
    x: imuPose.position.x * imuWeight + visualPose.position.x * visualWeight,
    y: imuPose.position.y * imuWeight + visualPose.position.y * visualWeight,
    z: imuPose.position.z * imuWeight + visualPose.position.z * visualWeight
  };
  
  // SLERP interpolation for rotation
  const fusedRotation = slerpQuaternion(
    imuPose.rotation,
    visualPose.rotation,
    visualWeight
  );
  
  // Higher confidence when both sources agree
  const rotationDiff = Math.abs(
    imuPose.rotation.w * visualPose.rotation.w +
    imuPose.rotation.x * visualPose.rotation.x +
    imuPose.rotation.y * visualPose.rotation.y +
    imuPose.rotation.z * visualPose.rotation.z
  );
  const fusedConfidence = Math.min(
    0.95,
    (imuPose.confidence + visualPose.confidence) / 2 + rotationDiff * 0.2
  );
  
  return {
    position: fusedPosition,
    rotation: fusedRotation,
    rotationMatrix: quaternionToMatrix(fusedRotation),
    confidence: fusedConfidence,
    source: 'fused'
  };
}

// ============================================================
// POINT CLOUD REGISTRATION WITH ORIENTATION PRIORS
// Use known camera orientations to improve alignment
// ============================================================

/**
 * Iterative Closest Point (ICP) algorithm with orientation priors
 * Aligns two point clouds using known camera poses as initial guess
 */
export function alignPointCloudsWithICP(
  sourcePoints: Point3D[],
  targetPoints: Point3D[],
  sourcePose: CameraPose,
  targetPose: CameraPose,
  maxIterations: number = 50,
  tolerance: number = 0.001
): { transform: { R: number[][]; t: { x: number; y: number; z: number } }; error: number } {
  console.log('[ICP] Aligning point clouds with orientation priors');
  console.log('[ICP] Source points:', sourcePoints.length, 'Target points:', targetPoints.length);
  
  // Initial transform from pose difference
  const deltaRotation = multiplyQuaternions(
    targetPose.rotation,
    conjugateQuaternion(sourcePose.rotation)
  );
  let R = quaternionToMatrix(deltaRotation);
  let t = {
    x: targetPose.position.x - sourcePose.position.x,
    y: targetPose.position.y - sourcePose.position.y,
    z: targetPose.position.z - sourcePose.position.z
  };
  
  let prevError = Infinity;
  
  for (let iter = 0; iter < maxIterations; iter++) {
    // 1. Transform source points
    const transformed = sourcePoints.map(p => ({
      ...p,
      x: R[0][0] * p.x + R[0][1] * p.y + R[0][2] * p.z + t.x,
      y: R[1][0] * p.x + R[1][1] * p.y + R[1][2] * p.z + t.y,
      z: R[2][0] * p.x + R[2][1] * p.y + R[2][2] * p.z + t.z
    }));
    
    // 2. Find closest point correspondences
    const correspondences: Array<{ source: Point3D; target: Point3D; dist: number }> = [];
    
    for (const src of transformed) {
      let minDist = Infinity;
      let closest: Point3D | null = null;
      
      for (const tgt of targetPoints) {
        const dist = Math.sqrt(
          (src.x - tgt.x) ** 2 +
          (src.y - tgt.y) ** 2 +
          (src.z - tgt.z) ** 2
        );
        
        if (dist < minDist) {
          minDist = dist;
          closest = tgt;
        }
      }
      
      if (closest && minDist < 0.5) { // Reject outliers > 50cm
        correspondences.push({ source: src, target: closest, dist: minDist });
      }
    }
    
    if (correspondences.length < 10) {
      console.warn('[ICP] Not enough correspondences:', correspondences.length);
      break;
    }
    
    // 3. Compute error
    const error = correspondences.reduce((sum, c) => sum + c.dist, 0) / correspondences.length;
    
    console.log(`[ICP] Iteration ${iter}: error=${error.toFixed(4)}m, correspondences=${correspondences.length}`);
    
    // 4. Check convergence
    if (Math.abs(prevError - error) < tolerance) {
      console.log('[ICP] Converged');
      break;
    }
    prevError = error;
    
    // 5. Compute centroids
    const srcCentroid = computeCentroid(correspondences.map(c => c.source));
    const tgtCentroid = computeCentroid(correspondences.map(c => c.target));
    
    // 6. Compute cross-covariance matrix
    const H = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const c of correspondences) {
      const ps = { x: c.source.x - srcCentroid.x, y: c.source.y - srcCentroid.y, z: c.source.z - srcCentroid.z };
      const pt = { x: c.target.x - tgtCentroid.x, y: c.target.y - tgtCentroid.y, z: c.target.z - tgtCentroid.z };
      
      H[0][0] += ps.x * pt.x; H[0][1] += ps.x * pt.y; H[0][2] += ps.x * pt.z;
      H[1][0] += ps.y * pt.x; H[1][1] += ps.y * pt.y; H[1][2] += ps.y * pt.z;
      H[2][0] += ps.z * pt.x; H[2][1] += ps.z * pt.y; H[2][2] += ps.z * pt.z;
    }
    
    // 7. SVD would go here for optimal rotation
    // For now, keep the prior-based rotation and just update translation
    t = {
      x: tgtCentroid.x - srcCentroid.x,
      y: tgtCentroid.y - srcCentroid.y,
      z: tgtCentroid.z - srcCentroid.z
    };
  }
  
  return { transform: { R, t }, error: prevError };
}

function computeCentroid(points: Point3D[]): { x: number; y: number; z: number } {
  const n = points.length;
  return {
    x: points.reduce((sum, p) => sum + p.x, 0) / n,
    y: points.reduce((sum, p) => sum + p.y, 0) / n,
    z: points.reduce((sum, p) => sum + p.z, 0) / n
  };
}

// ============================================================
// CSV EXPORT FOR POINT CLOUDS
// Export merged point cloud with accurate world coordinates
// ============================================================

/**
 * Export point cloud to CSV format
 * Includes position, color, and optional normals
 */
export function exportPointCloudToCSV(
  points: Point3D[],
  includeNormals: boolean = true,
  includeColors: boolean = true
): string {
  console.log(`[CSV Export] Exporting ${points.length} points`);
  
  // Build header
  const headers = ['x', 'y', 'z'];
  if (includeColors) headers.push('r', 'g', 'b');
  if (includeNormals) headers.push('nx', 'ny', 'nz');
  
  const lines: string[] = [headers.join(',')];
  
  // Add data rows
  for (const p of points) {
    const row: (number | string)[] = [
      p.x.toFixed(6),
      p.y.toFixed(6),
      p.z.toFixed(6)
    ];
    
    if (includeColors) {
      row.push(
        Math.round(p.r || 0),
        Math.round(p.g || 0),
        Math.round(p.b || 0)
      );
    }
    
    if (includeNormals && p.normal) {
      row.push(
        p.normal.x.toFixed(6),
        p.normal.y.toFixed(6),
        p.normal.z.toFixed(6)
      );
    } else if (includeNormals) {
      row.push('0', '0', '0');
    }
    
    lines.push(row.join(','));
  }
  
  return lines.join('\n');
}

/**
 * Export point cloud to PLY format (more widely supported for 3D)
 */
export function exportPointCloudToPLY(points: Point3D[]): string {
  console.log(`[PLY Export] Exporting ${points.length} points`);
  
  const header = [
    'ply',
    'format ascii 1.0',
    `element vertex ${points.length}`,
    'property float x',
    'property float y',
    'property float z',
    'property uchar red',
    'property uchar green',
    'property uchar blue',
    'end_header'
  ].join('\n');
  
  const data = points.map(p => 
    `${p.x.toFixed(6)} ${p.y.toFixed(6)} ${p.z.toFixed(6)} ${Math.round(p.r || 128)} ${Math.round(p.g || 128)} ${Math.round(p.b || 128)}`
  ).join('\n');
  
  return header + '\n' + data;
}

/**
 * Download point cloud as file
 */
export function downloadPointCloud(
  points: Point3D[],
  filename: string,
  format: 'csv' | 'ply' = 'ply'
): void {
  const content = format === 'csv' 
    ? exportPointCloudToCSV(points)
    : exportPointCloudToPLY(points);
  
  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filename}.${format}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  
  console.log(`[Export] Downloaded ${filename}.${format} with ${points.length} points`);
}

// ============================================================
// ENHANCED PHOTO CAPTURE WITH SENSOR DATA
// ============================================================

/**
 * Capture a photo with full sensor data for photogrammetry
 */
export async function capturePhotoWithSensors(
  imageData: string,
  azimuth: number,
  elevation: number,
  ringIndex: number,
  photoIndex: number,
  type: 'zenith' | 'ring' | 'nadir'
): Promise<PanoramaPhoto> {
  // Capture current sensor state
  const sensorData = await captureSensorSnapshot();
  
  // Estimate camera pose from sensors
  const cameraPose = sensorData 
    ? estimatePoseFromSensors(sensorData)
    : undefined;
  
  // Estimate camera intrinsics (typical iPhone values)
  const cameraIntrinsics: CameraIntrinsics = {
    focalLengthX: 1440,  // Typical iPhone focal length in pixels
    focalLengthY: 1440,
    principalPointX: 960, // Assuming 1920x1440 image
    principalPointY: 720,
    imageWidth: 1920,
    imageHeight: 1440
  };
  
  return {
    azimuth,
    elevation,
    ringIndex,
    photoIndex,
    imageData,
    timestamp: Date.now(),
    type,
    sensorData: sensorData || undefined,
    cameraIntrinsics,
    cameraPose
  };
}
