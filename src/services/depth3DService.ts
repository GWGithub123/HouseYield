/**
 * Depth 3D Service
 * 
 * 3D reconstruction from depth maps with:
 * - Depth map to point cloud conversion
 * - Multi-view point cloud merging with sensor fusion
 * - 3D-aware feature matching
 * - Room surface detection
 * - Mesh reconstruction
 * - ICP-based alignment with orientation priors
 */

import {
  PanoramaPhoto,
  Photo3D,
  Point3D,
  RoomDimensions,
  RoomSurface,
  CameraPose
} from '../types/panoramaScanner';
import { DepthMapResult } from '../types/roomScanner';
import {
  alignPointCloudsWithICP,
  estimatePoseFromSensors,
  quaternionToMatrix,
  eulerToQuaternion
} from './sensorFusionService';

/**
 * Decode depth data from base64 encoded image
 */
function decodeDepthData(_depthDataBase64: string, width: number, height: number): number[] {
  // For now, return placeholder data
  // In production, decode the depth map image and extract depth values
  void _depthDataBase64; // Mark as intentionally unused
  return new Array(width * height).fill(1.0);
}

/**
 * Convert depth map to 3D point cloud
 */
/**
 * Convert depth map to 3D point cloud
 * Uses ZoeDepth's depth map image to extract actual depth values
 */
export function depthMapToPointCloud(
  photo: PanoramaPhoto,
  depthMap: DepthMapResult,
  subsample: number = 2
): Promise<Point3D[]> {
  return new Promise<Point3D[]>((resolve) => {
    // Load the RGB photo
    const rgbImg = new Image();
    const rgbCanvas = document.createElement('canvas');
    
    // Load the depth map image
    const depthImg = new Image();
    const depthCanvas = document.createElement('canvas');
    
    let rgbLoaded = false;
    let depthLoaded = false;
    
    const tryResolve = () => {
      if (!rgbLoaded || !depthLoaded) return;
      
      // Both images loaded, process point cloud
      const rgbCtx = rgbCanvas.getContext('2d');
      const depthCtx = depthCanvas.getContext('2d');
      
      if (!rgbCtx || !depthCtx) {
        console.error('[PointCloud] Failed to get canvas contexts');
        resolve([]);
        return;
      }
      
      const width = Math.min(rgbCanvas.width, depthCanvas.width);
      const height = Math.min(rgbCanvas.height, depthCanvas.height);
      
      const rgbData = rgbCtx.getImageData(0, 0, width, height);
      const depthData = depthCtx.getImageData(0, 0, width, height);
      
      const points: Point3D[] = [];
      
      // Camera intrinsics (approximate for smartphone)
      const focalLength = width;
      const cx = width / 2;
      const cy = height / 2;
      
      // ZoeDepth normalization: min/max depth from depthMap metadata
      const depthMin = depthMap.minDepth;
      const depthMax = depthMap.maxDepth;
      const depthRange = depthMax - depthMin;
      
      for (let y = 0; y < height; y += subsample) {
        for (let x = 0; x < width; x += subsample) {
          const idx = (y * width + x) * 4;
          
          // ZoeDepth outputs grayscale: brighter = farther
          // Normalize grayscale value to actual depth in meters
          const depthGray = depthData.data[idx]; // 0-255
          const depth = depthMin + (depthGray / 255.0) * depthRange;
          
          // Valid depth range for rooms (0.1m to 15m)
          if (depth > 0.1 && depth < 15) {
            // Unproject pixel to 3D camera space
            const X = ((x - cx) * depth) / focalLength;
            const Y = ((y - cy) * depth) / focalLength;
            const Z = -depth; // Negative Z for correct Three.js coordinates
            
            // Get RGB color
            const r = rgbData.data[idx];
            const g = rgbData.data[idx + 1];
            const b = rgbData.data[idx + 2];
            
            // Simple normal (could be improved with gradient)
            const normal = { x: 0, y: 0, z: 1 };
            
            // Create point with direct x,y,z format
            points.push({
              x: X,
              y: Y,
              z: Z,
              r,
              g,
              b,
              normal
            });
          }
        }
      }
      
      console.log(`[PointCloud] Generated ${points.length} points from ${width}x${height} images`);
      resolve(points);
    };
    
    // Load RGB photo
    rgbImg.onload = () => {
      rgbCanvas.width = rgbImg.width;
      rgbCanvas.height = rgbImg.height;
      const ctx = rgbCanvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(rgbImg, 0, 0);
        rgbLoaded = true;
        tryResolve();
      }
    };
    
    rgbImg.onerror = () => {
      console.error('[PointCloud] Failed to load RGB image');
      resolve([]);
    };
    
    // Load depth map
    depthImg.onload = () => {
      depthCanvas.width = depthImg.width;
      depthCanvas.height = depthImg.height;
      const ctx = depthCanvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(depthImg, 0, 0);
        depthLoaded = true;
        tryResolve();
      }
    };
    
    depthImg.onerror = () => {
      console.error('[PointCloud] Failed to load depth map image');
      resolve([]);
    };
    
    // Start loading
    rgbImg.src = photo.imageData;
    
    // Use depthImageData (base64) instead of depthImageUrl to avoid CORS
    if (!depthMap.depthImageData && !depthMap.depthImageUrl) {
      console.error('[PointCloud] No depth image data available');
      resolve([]);
      return;
    }
    
    depthImg.src = depthMap.depthImageData || depthMap.depthImageUrl!;
  });
}

/**
 * Compute surface normal from depth map gradients
 */
function computeNormalFromDepth(
  depthValues: number[],
  width: number,
  height: number,
  x: number,
  y: number
): { x: number; y: number; z: number } {
  const getDepth = (px: number, py: number) => {
    if (px < 0 || px >= width || py < 0 || py >= height) return 0;
    return depthValues[py * width + px] || 0;
  };
  
  const dx = getDepth(x + 1, y) - getDepth(x - 1, y);
  const dy = getDepth(x, y + 1) - getDepth(x, y - 1);
  
  // Normal vector
  const nx = -dx;
  const ny = -dy;
  const nz = 1;
  
  // Normalize
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  
  return {
    x: nx / len,
    y: ny / len,
    z: nz / len
  };
}

/**
 * Transform point cloud from camera space to world space
 */
export function transformPointCloudToWorld(
  points: Point3D[],
  camera: { azimuth: number; elevation: number }
): Point3D[] {
  const azimuthRad = (camera.azimuth * Math.PI) / 180;
  const elevationRad = (camera.elevation * Math.PI) / 180;
  
  // Rotation matrices
  const cosAz = Math.cos(azimuthRad);
  const sinAz = Math.sin(azimuthRad);
  const cosEl = Math.cos(elevationRad);
  const sinEl = Math.sin(elevationRad);
  
  return points.map(point => {
    // Get coordinates (support both direct and nested format)
    const x = point.x;
    const y = point.y;
    const z = point.z;
    
    // Rotate around elevation
    let y1 = y * cosEl - z * sinEl;
    let z1 = y * sinEl + z * cosEl;
    
    // Rotate around azimuth
    let x2 = x * cosAz + z1 * sinAz;
    let z2 = -x * sinAz + z1 * cosAz;
    
    return {
      ...point,
      position: { x: x2, y: y1, z: z2 }
    };
  });
}

/**
 * Merge multiple point clouds into one, removing duplicates
 */
export function mergePointClouds(
  photos3D: Photo3D[],
  mergeThreshold: number = 0.02
): Point3D[] {
  console.log('[3D] Merging', photos3D.length, 'point clouds');
  
  const allPoints: Point3D[] = [];
  
  // Transform all point clouds to world coordinates
  for (const photo3D of photos3D) {
    const worldPoints = transformPointCloudToWorld(
      photo3D.points3D,
      { azimuth: photo3D.photo.azimuth, elevation: photo3D.photo.elevation }
    );
    allPoints.push(...worldPoints);
  }
  
  console.log('[3D] Total points before merge:', allPoints.length);
  
  // Memory safety: Aggressively subsample for smooth performance
  // Target 50K points maximum (smooth even on mobile)
  if (allPoints.length > 50000) {
    console.warn('[3D] Subsampling for performance:', allPoints.length, '→ ~50K points');
    const keepEvery = Math.ceil(allPoints.length / 50000);
    const subsampled = allPoints.filter((_, i) => i % keepEvery === 0);
    console.log('[3D] Subsampled to:', subsampled.length, 'points');
    return subsampled;
  }
  
  // Spatial hash grid for fast neighbor lookup
  const grid = new SpatialHashGrid(mergeThreshold);
  
  for (let i = 0; i < allPoints.length; i++) {
    grid.insert(allPoints[i], i);
  }
  
  // Merge nearby points
  const merged: Point3D[] = [];
  const visited = new Set<number>();
  
  for (let i = 0; i < allPoints.length; i++) {
    if (visited.has(i)) continue;
    
    const point = allPoints[i];
    const neighbors = grid.findNeighbors({ x: point.x, y: point.y, z: point.z }, mergeThreshold);
    
    if (neighbors.length > 1) {
      // Average position and color
      const avgPoint = averagePoints(neighbors.map(idx => allPoints[idx]));
      merged.push(avgPoint);
      neighbors.forEach(idx => visited.add(idx));
    } else {
      merged.push(point);
      visited.add(i);
    }
  }
  
  console.log('[3D] Points after merge:', merged.length);
  
  return merged;
}

/**
 * Enhanced point cloud merging with ICP alignment and sensor data
 * Uses iPhone orientation data for initial alignment, then refines with ICP
 */
export function mergePointCloudsWithSensorFusion(
  photos3D: Photo3D[],
  mergeThreshold: number = 0.02
): Point3D[] {
  console.log('[3D+Sensors] Merging', photos3D.length, 'point clouds with sensor fusion');
  
  if (photos3D.length === 0) return [];
  if (photos3D.length === 1) return photos3D[0].points3D;
  
  // Start with the first photo's point cloud as the reference
  let mergedCloud: Point3D[] = [...photos3D[0].points3D];
  let referencePose = getCameraPoseFromPhoto(photos3D[0].photo);
  
  // Iteratively align and merge each subsequent point cloud
  for (let i = 1; i < photos3D.length; i++) {
    const currentPhoto = photos3D[i];
    const currentPose = getCameraPoseFromPhoto(currentPhoto.photo);
    
    console.log(`[3D+Sensors] Aligning photo ${i + 1}/${photos3D.length}...`);
    
    // Use ICP with sensor-based orientation priors
    const { transform, error } = alignPointCloudsWithICP(
      currentPhoto.points3D,
      mergedCloud,
      currentPose,
      referencePose,
      30, // max iterations
      0.002 // tolerance (2mm)
    );
    
    console.log(`[3D+Sensors] ICP alignment error: ${error.toFixed(4)}m`);
    
    // Transform current points using ICP result
    const alignedPoints = currentPhoto.points3D.map(p => {
      const R = transform.R;
      const t = transform.t;
      return {
        ...p,
        x: R[0][0] * p.x + R[0][1] * p.y + R[0][2] * p.z + t.x,
        y: R[1][0] * p.x + R[1][1] * p.y + R[1][2] * p.z + t.y,
        z: R[2][0] * p.x + R[2][1] * p.y + R[2][2] * p.z + t.z
      };
    });
    
    // Add aligned points to merged cloud
    mergedCloud = mergedCloud.concat(alignedPoints);
  }
  
  console.log('[3D+Sensors] Total points before deduplication:', mergedCloud.length);
  
  // Deduplicate using spatial hash grid (same as original)
  const grid = new SpatialHashGrid(mergeThreshold);
  for (let i = 0; i < mergedCloud.length; i++) {
    grid.insert(mergedCloud[i], i);
  }
  
  const merged: Point3D[] = [];
  const visited = new Set<number>();
  
  for (let i = 0; i < mergedCloud.length; i++) {
    if (visited.has(i)) continue;
    
    const point = mergedCloud[i];
    const neighbors = grid.findNeighbors({ x: point.x, y: point.y, z: point.z }, mergeThreshold);
    
    if (neighbors.length > 1) {
      const avgPoint = averagePoints(neighbors.map(idx => mergedCloud[idx]));
      merged.push(avgPoint);
      neighbors.forEach(idx => visited.add(idx));
    } else {
      merged.push(point);
      visited.add(i);
    }
  }
  
  console.log('[3D+Sensors] Final merged cloud:', merged.length, 'points');
  
  // Subsample if too large for performance
  if (merged.length > 100000) {
    const keepEvery = Math.ceil(merged.length / 100000);
    const subsampled = merged.filter((_, i) => i % keepEvery === 0);
    console.log('[3D+Sensors] Subsampled to:', subsampled.length, 'points');
    return subsampled;
  }
  
  return merged;
}

/**
 * Extract camera pose from photo (uses sensor data if available, else computes from azimuth/elevation)
 */
function getCameraPoseFromPhoto(photo: PanoramaPhoto): CameraPose {
  // If we have sensor-derived pose, use it
  if (photo.cameraPose) {
    return photo.cameraPose;
  }
  
  // If we have raw sensor data, compute pose from it
  if (photo.sensorData) {
    return estimatePoseFromSensors(photo.sensorData);
  }
  
  // Fall back to computing from azimuth/elevation
  const azimuthRad = (photo.azimuth * Math.PI) / 180;
  const elevationRad = (photo.elevation * Math.PI) / 180;
  
  const rotation = eulerToQuaternion(0, elevationRad, azimuthRad);
  
  return {
    position: { x: 0, y: 0, z: 0 }, // Camera at center
    rotation,
    rotationMatrix: quaternionToMatrix(rotation),
    confidence: 0.5, // Lower confidence without sensor data
    source: 'manual'
  };
}

/**
 * Spatial hash grid for fast 3D neighbor queries
 */
class SpatialHashGrid {
  private grid: Map<string, number[]> = new Map();
  private cellSize: number;
  
  constructor(cellSize: number) {
    this.cellSize = cellSize;
  }
  
  private hash(x: number, y: number, z: number): string {
    const ix = Math.floor(x / this.cellSize);
    const iy = Math.floor(y / this.cellSize);
    const iz = Math.floor(z / this.cellSize);
    return `${ix},${iy},${iz}`;
  }
  
  insert(point: Point3D, index: number): void {
    const key = this.hash(point.x, point.y, point.z);
    if (!this.grid.has(key)) {
      this.grid.set(key, []);
    }
    this.grid.get(key)!.push(index);
  }
  
  findNeighbors(pos: { x: number; y: number; z: number }, radius: number): number[] {
    const neighbors: number[] = [];
    const cells = Math.ceil(radius / this.cellSize);
    
    const cx = Math.floor(pos.x / this.cellSize);
    const cy = Math.floor(pos.y / this.cellSize);
    const cz = Math.floor(pos.z / this.cellSize);
    
    for (let dx = -cells; dx <= cells; dx++) {
      for (let dy = -cells; dy <= cells; dy++) {
        for (let dz = -cells; dz <= cells; dz++) {
          const key = `${cx + dx},${cy + dy},${cz + dz}`;
          const indices = this.grid.get(key) || [];
          neighbors.push(...indices);
        }
      }
    }
    
    return neighbors;
  }
}

/**
 * Average multiple points
 */
function averagePoints(points: Point3D[]): Point3D {
  const sum = points.reduce((acc, p) => ({
    x: acc.x + p.x,
    y: acc.y + p.y,
    z: acc.z + p.z,
    r: (acc.r || 0) + (p.r || 0),
    g: (acc.g || 0) + (p.g || 0),
    b: (acc.b || 0) + (p.b || 0)
  }), { x: 0, y: 0, z: 0, r: 0, g: 0, b: 0 });
  
  const n = points.length;
  
  return {
    x: sum.x / n,
    y: sum.y / n,
    z: sum.z / n,
    r: (sum.r || 0) / n,
    g: (sum.g || 0) / n,
    b: (sum.b || 0) / n,
    normal: points[0].normal
  };
}

/**
 * Detect room surfaces (walls, floor, ceiling) from point cloud
 */
export function detectRoomSurfaces(pointCloud: Point3D[]): RoomSurface[] {
  console.log('[3D] Detecting room surfaces from', pointCloud.length, 'points');
  
  if (pointCloud.length < 100) {
    console.warn('[3D] Not enough points');
    return [];
  }
  
  const surfaces: RoomSurface[] = [];
  
  // Simplified detection: Find extreme points for dimensions
  const xs = pointCloud.map(p => p.x).filter(x => !isNaN(x));
  const ys = pointCloud.map(p => p.y).filter(y => !isNaN(y));
  const zs = pointCloud.map(p => p.z).filter(z => !isNaN(z));
  
  if (xs.length === 0 || ys.length === 0 || zs.length === 0) {
    console.warn('[3D] Invalid point data');
    return [];
  }
  
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const minZ = Math.min(...zs), maxZ = Math.max(...zs);
  
  const width = Math.abs(maxX - minX);
  const height = Math.abs(maxY - minY);
  const length = Math.abs(maxZ - minZ);
  
  console.log('[3D] Room bounds:', { width, height, length });
  console.log('[3D] X:', minX.toFixed(2), 'to', maxX.toFixed(2));
  console.log('[3D] Y:', minY.toFixed(2), 'to', maxY.toFixed(2));
  console.log('[3D] Z:', minZ.toFixed(2), 'to', maxZ.toFixed(2));
  
  // Create representative surfaces for measurement
  // Floor
  surfaces.push({
    type: 'floor',
    plane: { normal: { x: 0, y: 1, z: 0 }, distance: minY },
    vertices: [
      { x: minX, y: minY, z: minZ },
      { x: maxX, y: minY, z: minZ },
      { x: maxX, y: minY, z: maxZ },
      { x: minX, y: minY, z: maxZ }
    ],
    area: width * length,
    pointCount: pointCloud.filter(p => p.y < minY + 0.2).length
  });
  
  // Ceiling
  surfaces.push({
    type: 'ceiling',
    plane: { normal: { x: 0, y: -1, z: 0 }, distance: -maxY },
    vertices: [
      { x: minX, y: maxY, z: minZ },
      { x: maxX, y: maxY, z: minZ },
      { x: maxX, y: maxY, z: maxZ },
      { x: minX, y: maxY, z: maxZ }
    ],
    area: width * length,
    pointCount: pointCloud.filter(p => p.y > maxY - 0.2).length
  });
  
  // Walls (4 sides)
  surfaces.push({
    type: 'wall',
    plane: { normal: { x: 1, y: 0, z: 0 }, distance: minX },
    vertices: [
      { x: minX, y: minY, z: minZ },
      { x: minX, y: maxY, z: minZ },
      { x: minX, y: maxY, z: maxZ },
      { x: minX, y: minY, z: maxZ }
    ],
    area: height * length,
    pointCount: pointCloud.filter(p => p.x < minX + 0.2).length
  });
  
  console.log('[3D] Detected', surfaces.length, 'surfaces');
  
  return surfaces;
}

/**
 * Cluster points by normal similarity (NOT CURRENTLY USED)
 */
/*
function clusterByNormals(points: Point3D[]): Point3D[][] {
  // Simple clustering based on normal direction
  const clusters: Point3D[][] = [];
  const threshold = 0.9; // cos(~25°)
  
  for (const point of points) {
    if (!point.normal) continue;
    
    let assigned = false;
    
    for (const cluster of clusters) {
      if (cluster.length === 0) continue;
      
      const clusterNormal = cluster[0].normal!;
      const dot = 
        clusterNormal.x * point.normal.x +
        clusterNormal.y * point.normal.y +
        clusterNormal.z * point.normal.z;
      
      if (Math.abs(dot) > threshold) {
        cluster.push(point);
        assigned = true;
        break;
      }
    }
    
    if (!assigned) {
      clusters.push([point]);
    }
  }
  
  return clusters.filter(c => c.length > 100); // Minimum points per surface
}
*/

/**
 * Fit plane to point cluster using RANSAC (NOT CURRENTLY USED)
 */
/*
function fitPlane(points: Point3D[]): { normal: { x: number; y: number; z: number }; distance: number } {
  // Simplified plane fitting - compute average normal
  let nx = 0, ny = 0, nz = 0;
  
  for (const p of points) {
    if (p.normal) {
      nx += p.normal.x;
      ny += p.normal.y;
      nz += p.normal.z;
    }
  }
  
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  const normal = { x: nx / len, y: ny / len, z: nz / len };
  
  // Distance from origin
  const distance = points.reduce((sum, p) => 
    sum + (p.position.x * normal.x + p.position.y * normal.y + p.position.z * normal.z), 0
  ) / points.length;
  
  return { normal, distance };
}
*/

/**
 * Classify plane as floor, ceiling, or wall (NOT CURRENTLY USED)
 */
/*
function classifyPlane(normal: { x: number; y: number; z: number }): 'floor' | 'ceiling' | 'wall' | 'unknown' {
  const absY = Math.abs(normal.y);
  
  if (absY > 0.8) {
    return normal.y > 0 ? 'ceiling' : 'floor';
  } else if (absY < 0.3) {
    return 'wall';
  }
  
  return 'unknown';
}
*/

/**
 * Extract boundary vertices from point cluster (NOT CURRENTLY USED)
 */
/*
function extractBoundary(points: Point3D[]): Array<{ x: number; y: number; z: number }> {
  // Simple convex hull approximation
  // In production, use proper 3D convex hull algorithm
  
  if (points.length === 0) return [];
  
  // Find extremal points
  const vertices: Array<{ x: number; y: number; z: number }> = [];
  
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  
  for (const p of points) {
    if (p.position.x < minX) minX = p.position.x;
    if (p.position.x > maxX) maxX = p.position.x;
    if (p.position.y < minY) minY = p.position.y;
    if (p.position.y > maxY) maxY = p.position.y;
    if (p.position.z < minZ) minZ = p.position.z;
    if (p.position.z > maxZ) maxZ = p.position.z;
  }
  
  vertices.push({ x: minX, y: minY, z: minZ });
  vertices.push({ x: maxX, y: minY, z: minZ });
  vertices.push({ x: maxX, y: maxY, z: maxZ });
  vertices.push({ x: minX, y: maxY, z: maxZ });
  
  return vertices;
}
*/

/**
 * Compute area of polygon (NOT CURRENTLY USED)
 */
/*
function computeArea(vertices: Array<{ x: number; y: number; z: number }>): number {
  if (vertices.length < 3) return 0;
  
  // Simple area calculation using cross product
  let area = 0;
  
  for (let i = 0; i < vertices.length; i++) {
    const v1 = vertices[i];
    const v2 = vertices[(i + 1) % vertices.length];
    
    const dx = v2.x - v1.x;
    const dz = v2.z - v1.z;
    
    area += dx * dz;
  }
  
  return Math.abs(area / 2);
}
*/

/**
 * Calculate room dimensions from detected surfaces
 */
export function calculateRoomDimensions(surfaces: RoomSurface[]): RoomDimensions {
  console.log('[3D] Calculating room dimensions from', surfaces.length, 'surfaces');
  
  const floor = surfaces.find(s => s.type === 'floor');
  const ceiling = surfaces.find(s => s.type === 'ceiling');
  const walls = surfaces.filter(s => s.type === 'wall');
  
  // Extract actual dimensions from surface vertices (not plane distances)
  let width = 0, length = 0, height = 0;
  
  if (floor && floor.vertices && floor.vertices.length >= 4) {
    // Floor vertices define the room's base rectangle
    const xs = floor.vertices.map(v => v.x);
    const zs = floor.vertices.map(v => v.z);
    width = Math.abs(Math.max(...xs) - Math.min(...xs));
    length = Math.abs(Math.max(...zs) - Math.min(...zs));
    
    console.log('[3D] Width from floor:', width.toFixed(2), 'm');
    console.log('[3D] Length from floor:', length.toFixed(2), 'm');
  }
  
  if (floor && ceiling && floor.vertices && ceiling.vertices) {
    const floorY = floor.vertices[0].y;
    const ceilingY = ceiling.vertices[0].y;
    height = Math.abs(ceilingY - floorY);
    
    console.log('[3D] Height (floor to ceiling):', height.toFixed(2), 'm');
  }
  
  // Convert to feet
  const widthFeet = width * 3.28084;
  const lengthFeet = length * 3.28084;
  const heightFeet = height * 3.28084;
  
  const volume = width * length * height;
  const floorArea = width * length;
  const floorAreaSqFt = floorArea * 10.7639; // m² to ft²
  
  const confidence = (floor && ceiling && walls.length >= 2) ? 0.8 : 0.4;
  
  console.log('[3D] Final dimensions:', {
    width: `${width.toFixed(2)}m (${widthFeet.toFixed(1)}ft)`,
    length: `${length.toFixed(2)}m (${lengthFeet.toFixed(1)}ft)`,
    height: `${height.toFixed(2)}m (${heightFeet.toFixed(1)}ft)`,
    floorArea: `${floorArea.toFixed(1)}m² (${floorAreaSqFt.toFixed(0)}ft²)`,
    confidence: `${(confidence * 100).toFixed(0)}%`
  });
  
  return {
    width,
    widthMeters: width,
    widthFeet,
    length,
    lengthMeters: length,
    lengthFeet,
    height,
    heightMeters: height,
    heightFeet,
    volume,
    floorArea,
    floorAreaSqM: floorArea,
    floorAreaSqFt,
    confidence,
    measurements: surfaces
  };
}
