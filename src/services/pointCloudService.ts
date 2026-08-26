/**
 * Point Cloud Loading Service
 * 
 * Handles chunked loading of large point cloud files from the server.
 * Point clouds can be 5M+ points (500MB+), so we load in 100k chunks.
 */

export interface PointCloudData {
  points: number[][];  // [x, y, z] coordinates
  colors: number[][];  // [r, g, b] values (0-1)
  total: number;
  loaded: number;
  isComplete: boolean;
}

export interface PointCloudLoadProgress {
  loaded: number;
  total: number;
  percentage: number;
}

/**
 * Load point cloud from server in chunks (streams from NDJSON file)
 * @param filename - The point cloud filename (e.g., "pointcloud_123.ndjson")
 * @param onProgress - Callback for loading progress
 * @returns Complete point cloud data
 */
export async function loadPointCloud(
  filename: string,
  onProgress?: (progress: PointCloudLoadProgress) => void
): Promise<PointCloudData> {
  const CHUNK_SIZE = 500000; // 500k points per request for faster loading of large clouds
  let offset = 0;
  let total = 0;
  let hasMore = true;
  
  const allPoints: number[][] = [];
  const allColors: number[][] = [];
  
  console.log(`[PointCloud] Starting streaming load of ${filename}`);
  
  while (hasMore) {
    try {
      const url = `/api/image-stitching/point-cloud/${filename}?offset=${offset}&limit=${CHUNK_SIZE}`;
      const response = await fetch(url);
      
      if (!response.ok) {
        throw new Error(`Failed to load point cloud chunk: ${response.statusText}`);
      }
      
      const chunk = await response.json();
      
      // Check for errors
      if (chunk.error) {
        console.error('[PointCloud] Server error:', chunk.error);
        throw new Error(chunk.error);
      }
      
      // Update total on first chunk
      if (offset === 0) {
        total = chunk.total;
        console.log(`[PointCloud] Total points: ${total.toLocaleString()}`);
      }
      
      // Add points and colors
      if (chunk.points && chunk.points.length > 0) {
        // Use for loop instead of spread operator to avoid stack overflow
        for (let i = 0; i < chunk.points.length; i++) {
          allPoints.push(chunk.points[i]);
        }
        if (chunk.colors) {
          for (let i = 0; i < chunk.colors.length; i++) {
            allColors.push(chunk.colors[i]);
          }
        }
      }
      
      offset += chunk.points?.length || 0;
      hasMore = chunk.hasMore;
      
      // Report progress
      if (onProgress) {
        onProgress({
          loaded: offset,
          total,
          percentage: Math.round((offset / total) * 100)
        });
      }
      
      console.log(`[PointCloud] Streamed ${offset.toLocaleString()} / ${total.toLocaleString()} (${Math.round((offset / total) * 100)}%)`);
      
    } catch (error) {
      console.error('[PointCloud] Error loading chunk:', error);
      throw error;
    }
  }
  
  console.log(`[PointCloud] Complete! Loaded ${allPoints.length.toLocaleString()} points`);
  
  return {
    points: allPoints,
    colors: allColors,
    total,
    loaded: allPoints.length,
    isComplete: true
  };
}

/**
 * Load point cloud with automatic retry on failure
 */
export async function loadPointCloudWithRetry(
  filename: string,
  onProgress?: (progress: PointCloudLoadProgress) => void,
  maxRetries: number = 3
): Promise<PointCloudData> {
  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await loadPointCloud(filename, onProgress);
    } catch (error) {
      lastError = error as Error;
      console.warn(`[PointCloud] Attempt ${attempt}/${maxRetries} failed:`, error);
      
      if (attempt < maxRetries) {
        // Wait before retry (exponential backoff)
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      }
    }
  }
  
  throw lastError || new Error('Failed to load point cloud after retries');
}

/**
 * Calculate room dimensions from loaded point cloud
 * Uses percentile-based bounding box for robustness
 */
export function calculateDimensionsFromPointCloud(
  pointCloud: PointCloudData,
  percentileLow: number = 5,
  percentileHigh: number = 95
): {
  widthMeters: number;
  lengthMeters: number;
  heightMeters: number;
  widthFeet: number;
  lengthFeet: number;
  heightFeet: number;
} | null {
  if (!pointCloud.points || pointCloud.points.length < 1000) {
    return null;
  }
  
  const points = pointCloud.points;
  
  // Extract X, Y, Z coordinates
  const xCoords = points.map(p => p[0]).sort((a, b) => a - b);
  const yCoords = points.map(p => p[1]).sort((a, b) => a - b);
  const zCoords = points.map(p => p[2]).sort((a, b) => a - b);
  
  // Get percentile values
  const lowIdx = Math.floor(points.length * percentileLow / 100);
  const highIdx = Math.floor(points.length * percentileHigh / 100);
  
  const width = xCoords[highIdx] - xCoords[lowIdx];
  const height = yCoords[highIdx] - yCoords[lowIdx];
  const length = zCoords[highIdx] - zCoords[lowIdx];
  
  return {
    widthMeters: width,
    lengthMeters: length,
    heightMeters: height,
    widthFeet: width * 3.28084,
    lengthFeet: length * 3.28084,
    heightFeet: height * 3.28084
  };
}

/**
 * Downsample point cloud for visualization (keep every Nth point)
 */
export function downsamplePointCloud(
  pointCloud: PointCloudData,
  targetPoints: number
): PointCloudData {
  const ratio = pointCloud.points.length / targetPoints;
  if (ratio <= 1) return pointCloud;
  
  const step = Math.ceil(ratio);
  const sampledPoints: number[][] = [];
  const sampledColors: number[][] = [];
  
  for (let i = 0; i < pointCloud.points.length; i += step) {
    sampledPoints.push(pointCloud.points[i]);
    if (pointCloud.colors[i]) {
      sampledColors.push(pointCloud.colors[i]);
    }
  }
  
  return {
    points: sampledPoints,
    colors: sampledColors,
    total: pointCloud.total,
    loaded: sampledPoints.length,
    isComplete: true
  };
}
