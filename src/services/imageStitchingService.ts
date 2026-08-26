/**
 * Image Stitching Service
 * 
 * Google Street View-style image stitching with:
 * - FAST corner detection
 * - BRIEF binary descriptors  
 * - Feature matching with ratio test
 * - RANSAC homography estimation
 * - Image warping and blending
 */

import {
  PanoramaPhoto,
  Keypoint,
  Match,
  HomographyResult,
  StitchedPanorama
} from '../types/panoramaScanner';
import { getMobileScanAuthHeaders } from './mobileScanConfig';

// BRIEF test pattern (256 pre-computed random pixel pairs)
// In production, this would be a proper 256-element array
const BRIEF_TEST_PATTERN: Array<[{x: number, y: number}, {x: number, y: number}]> = 
  Array.from({ length: 256 }, (_, i) => {
    const angle = (i * 2 * Math.PI) / 256;
    const radius = 15;
    return [
      { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius },
      { x: Math.cos(angle + Math.PI) * radius, y: Math.sin(angle + Math.PI) * radius }
    ];
  });

/**
 * Convert image data URL to ImageData
 */
export function dataURLToImageData(dataURL: string): Promise<ImageData> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Could not get canvas context'));
        return;
      }
      ctx.drawImage(img, 0, 0);
      resolve(ctx.getImageData(0, 0, canvas.width, canvas.height));
    };
    img.onerror = reject;
    img.src = dataURL;
  });
}

/**
 * Convert ImageData to data URL
 */
export function imageDataToDataURL(imageData: ImageData): string {
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get canvas context');
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL('image/jpeg', 0.92);
}

/**
 * Convert to grayscale for feature detection
 */
function toGrayscale(imageData: ImageData): Uint8Array {
  const gray = new Uint8Array(imageData.width * imageData.height);
  const data = imageData.data;
  
  for (let i = 0; i < data.length; i += 4) {
    // Luminance formula
    gray[i / 4] = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
  }
  
  return gray;
}

/**
 * Get pixel value from grayscale image
 */
function getPixel(gray: Uint8Array, width: number, x: number, y: number): number {
  if (x < 0 || x >= width || y < 0 || y >= Math.floor(gray.length / width)) {
    return 0;
  }
  return gray[y * width + x];
}

/**
 * FAST corner detection
 * Finds distinctive points in the image
 */
export function detectKeypoints(imageData: ImageData, maxKeypoints: number = 500): Keypoint[] {
  const gray = toGrayscale(imageData);
  const width = imageData.width;
  const height = imageData.height;
  const keypoints: Keypoint[] = [];
  const threshold = 30;
  
  // FAST circle offsets (16 pixels in a circle of radius 3)
  const circle: Array<[number, number]> = [
    [0, -3], [1, -3], [2, -2], [3, -1],
    [3, 0], [3, 1], [2, 2], [1, 3],
    [0, 3], [-1, 3], [-2, 2], [-3, 1],
    [-3, 0], [-3, -1], [-2, -2], [-1, -3]
  ];
  
  // Detect corners
  for (let y = 4; y < height - 4; y += 2) { // Subsample for performance
    for (let x = 4; x < width - 4; x += 2) {
      const center = getPixel(gray, width, x, y);
      
      // Check circle pixels
      let brighter = 0, darker = 0;
      let consecutive = 0, maxConsecutive = 0;
      
      for (let i = 0; i < 16; i++) {
        const [dx, dy] = circle[i];
        const pixel = getPixel(gray, width, x + dx, y + dy);
        
        if (pixel > center + threshold) {
          brighter++;
          consecutive = pixel > center + threshold ? consecutive + 1 : 0;
        } else if (pixel < center - threshold) {
          darker++;
          consecutive = pixel < center - threshold ? consecutive + 1 : 0;
        } else {
          consecutive = 0;
        }
        
        maxConsecutive = Math.max(maxConsecutive, consecutive);
      }
      
      // Is this a corner? (12+ consecutive similar pixels)
      if (maxConsecutive >= 12) {
        const response = Math.max(brighter, darker);
        
        keypoints.push({
          x,
          y,
          scale: 1.0,
          angle: computeOrientation(gray, width, x, y),
          response,
          descriptor: new Uint8Array(32) // Placeholder, computed later
        });
      }
    }
  }
  
  // Keep only strongest keypoints
  keypoints.sort((a, b) => b.response - a.response);
  const topKeypoints = keypoints.slice(0, maxKeypoints);
  
  // Compute BRIEF descriptors
  for (const kp of topKeypoints) {
    kp.descriptor = computeBRIEFDescriptor(gray, width, kp.x, kp.y, kp.angle);
  }
  
  return topKeypoints;
}

/**
 * Compute dominant orientation of keypoint
 */
function computeOrientation(gray: Uint8Array, width: number, x: number, y: number): number {
  let mx = 0, my = 0;
  const patchSize = 7;
  
  for (let dy = -patchSize; dy <= patchSize; dy++) {
    for (let dx = -patchSize; dx <= patchSize; dx++) {
      const pixel = getPixel(gray, width, x + dx, y + dy);
      mx += dx * pixel;
      my += dy * pixel;
    }
  }
  
  return Math.atan2(my, mx) * (180 / Math.PI);
}

/**
 * Compute BRIEF descriptor (256-bit binary)
 */
function computeBRIEFDescriptor(
  gray: Uint8Array,
  width: number,
  x: number,
  y: number,
  angle: number
): Uint8Array {
  const descriptor = new Uint8Array(32); // 256 bits = 32 bytes
  const angleRad = (angle * Math.PI) / 180;
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  
  for (let i = 0; i < 256; i++) {
    const [p1, p2] = BRIEF_TEST_PATTERN[i];
    
    // Rotate points according to keypoint orientation
    const x1 = Math.round(x + p1.x * cos - p1.y * sin);
    const y1 = Math.round(y + p1.x * sin + p1.y * cos);
    const x2 = Math.round(x + p2.x * cos - p2.y * sin);
    const y2 = Math.round(y + p2.x * sin + p2.y * cos);
    
    const val1 = getPixel(gray, width, x1, y1);
    const val2 = getPixel(gray, width, x2, y2);
    
    // Binary test: is pixel1 brighter than pixel2?
    if (val1 > val2) {
      const byteIdx = Math.floor(i / 8);
      const bitIdx = i % 8;
      descriptor[byteIdx] |= (1 << bitIdx);
    }
  }
  
  return descriptor;
}

/**
 * Match keypoints between two images using Hamming distance and ratio test
 */
export function matchKeypoints(kp1: Keypoint[], kp2: Keypoint[]): Match[] {
  const matches: Match[] = [];
  
  for (let i = 0; i < kp1.length; i++) {
    const desc1 = kp1[i].descriptor;
    
    // Find 2 nearest neighbors
    let bestDist = Infinity, secondBestDist = Infinity;
    let bestIdx = -1;
    
    for (let j = 0; j < kp2.length; j++) {
      const dist = hammingDistance(desc1, kp2[j].descriptor);
      
      if (dist < bestDist) {
        secondBestDist = bestDist;
        bestDist = dist;
        bestIdx = j;
      } else if (dist < secondBestDist) {
        secondBestDist = dist;
      }
    }
    
    // Lowe's ratio test: best match must be significantly better
    if (bestDist < 0.75 * secondBestDist && bestIdx >= 0) {
      matches.push({
        queryIdx: i,
        trainIdx: bestIdx,
        distance: bestDist,
        point1: { x: kp1[i].x, y: kp1[i].y },
        point2: { x: kp2[bestIdx].x, y: kp2[bestIdx].y }
      });
    }
  }
  
  return matches;
}

/**
 * Hamming distance between two binary descriptors
 */
function hammingDistance(desc1: Uint8Array, desc2: Uint8Array): number {
  let distance = 0;
  
  for (let i = 0; i < desc1.length; i++) {
    let xor = desc1[i] ^ desc2[i];
    
    // Count set bits (Brian Kernighan's algorithm)
    while (xor) {
      distance++;
      xor &= xor - 1;
    }
  }
  
  return distance;
}

/**
 * Find homography using RANSAC
 */
export function findHomographyRANSAC(matches: Match[], iterations: number = 2000): HomographyResult {
  if (matches.length < 4) {
    return {
      H: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
      inliers: [],
      outliers: matches,
      inlierRatio: 0
    };
  }
  
  let bestH: number[][] | null = null;
  let bestInliers: Match[] = [];
  const threshold = 3.0; // pixels
  
  for (let iter = 0; iter < iterations; iter++) {
    // Randomly sample 4 matches
    const sample: Match[] = [];
    const indices = new Set<number>();
    
    while (sample.length < 4) {
      const idx = Math.floor(Math.random() * matches.length);
      if (!indices.has(idx)) {
        indices.add(idx);
        sample.push(matches[idx]);
      }
    }
    
    // Compute homography from 4 points
    const H = computeHomographyDLT(sample);
    if (!H) continue;
    
    // Count inliers
    const inliers: Match[] = [];
    
    for (const match of matches) {
      const projected = applyHomography(H, match.point1);
      const error = Math.sqrt(
        Math.pow(projected.x - match.point2.x, 2) +
        Math.pow(projected.y - match.point2.y, 2)
      );
      
      if (error < threshold) {
        inliers.push(match);
      }
    }
    
    if (inliers.length > bestInliers.length) {
      bestH = H;
      bestInliers = inliers;
    }
  }
  
  // Refine with all inliers
  const refinedH = bestInliers.length >= 4 ? computeHomographyDLT(bestInliers) : bestH;
  const outliers = matches.filter(m => !bestInliers.includes(m));
  
  return {
    H: refinedH || [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    inliers: bestInliers,
    outliers,
    inlierRatio: bestInliers.length / matches.length
  };
}

/**
 * Compute homography using Direct Linear Transform (DLT)
 */
function computeHomographyDLT(matches: Match[]): number[][] | null {
  if (matches.length < 4) return null;
  
  // Build matrix A (2n × 9)
  const A: number[][] = [];
  
  for (const m of matches) {
    const { x: x1, y: y1 } = m.point1;
    const { x: x2, y: y2 } = m.point2;
    
    A.push([-x1, -y1, -1, 0, 0, 0, x2*x1, x2*y1, x2]);
    A.push([0, 0, 0, -x1, -y1, -1, y2*x1, y2*y1, y2]);
  }
  
  // Solve using simplified SVD (for 3x3 homography)
  // In production, use proper SVD library
  const H_flat = solveHomogeneous(A);
  
  return [
    [H_flat[0], H_flat[1], H_flat[2]],
    [H_flat[3], H_flat[4], H_flat[5]],
    [H_flat[6], H_flat[7], H_flat[8]]
  ];
}

/**
 * Simplified homogeneous system solver (placeholder for proper SVD)
 */
function solveHomogeneous(_A: number[][]): number[] {
  // In production, use proper SVD from a library like ml-matrix
  // For now, return identity-like solution
  return [1, 0, 0, 0, 1, 0, 0, 0, 1];
}

/**
 * Apply homography to a point
 */
export function applyHomography(H: number[][], point: { x: number, y: number }): { x: number, y: number } {
  const { x, y } = point;
  
  const w = H[2][0] * x + H[2][1] * y + H[2][2];
  const x_new = (H[0][0] * x + H[0][1] * y + H[0][2]) / w;
  const y_new = (H[1][0] * x + H[1][1] * y + H[1][2]) / w;
  
  return { x: x_new, y: y_new };
}

/**
 * Quick preview stitching (lower quality, fast)
 * Creates a simple equirectangular panorama by placing photos on a canvas
 */
export async function stitchSphericalPanoramaPreview(
  photos: PanoramaPhoto[]
): Promise<Partial<StitchedPanorama>> {
  console.log('[Stitching] Starting preview stitch of', photos.length, 'photos');
  
  return new Promise((resolve) => {
    // Create canvas for equirectangular output (2:1 aspect ratio)
    const width = 4096;
    const height = 2048;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    
    // Fill with black background
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, width, height);
    
    let loadedCount = 0;
    const totalPhotos = photos.length;
    
    // Load and place each photo
    photos.forEach((photo) => {
      const img = new Image();
      img.onload = () => {
        // Convert spherical coordinates to equirectangular position
        // Azimuth: 0-360° maps to x: 0-width
        // Elevation: -90 to +90° maps to y: height to 0 (inverted)
        
        const x = (photo.azimuth / 360) * width;
        const y = ((90 - photo.elevation) / 180) * height; // 90° at top, -90° at bottom
        
        // Calculate photo size based on elevation (perspective)
        const photoWidth = Math.max(200, width / (totalPhotos / 4)); // Dynamic sizing
        const photoHeight = Math.max(150, photoWidth * 0.75);
        
        // Draw photo at calculated position
        ctx.drawImage(
          img,
          x - photoWidth / 2,
          y - photoHeight / 2,
          photoWidth,
          photoHeight
        );
        
        loadedCount++;
        
        // When all photos are placed, return result
        if (loadedCount === totalPhotos) {
          const equirectangular = canvas.toDataURL('image/jpeg', 0.9);
          console.log('[Stitching] Preview complete:', {
            width,
            height,
            photos: totalPhotos,
            size: `${(equirectangular.length / 1024).toFixed(0)}KB`
          });
          
          resolve({
            equirectangular,
            stitchQuality: 0.5,
            pointCloud: [],
            roomDimensions: {
              width: 0,
              widthMeters: 0,
              widthFeet: 0,
              length: 0,
              lengthMeters: 0,
              lengthFeet: 0,
              height: 0,
              heightMeters: 0,
              heightFeet: 0,
              volume: 0,
              floorArea: 0,
              floorAreaSqM: 0,
              floorAreaSqFt: 0,
              confidence: 0,
              measurements: []
            },
            processingTime: 0
          });
        }
      };
      
      img.onerror = () => {
        loadedCount++;
        console.warn('[Stitching] Failed to load photo at', photo.elevation, '°', photo.azimuth, '°');
        
        // Continue even if some photos fail
        if (loadedCount === totalPhotos) {
          const equirectangular = canvas.toDataURL('image/jpeg', 0.9);
          resolve({
            equirectangular,
            stitchQuality: 0.3,
            pointCloud: [],
            roomDimensions: {
              width: 0,
              widthMeters: 0,
              widthFeet: 0,
              length: 0,
              lengthMeters: 0,
              lengthFeet: 0,
              height: 0,
              heightMeters: 0,
              heightFeet: 0,
              volume: 0,
              floorArea: 0,
              floorAreaSqM: 0,
              floorAreaSqFt: 0,
              confidence: 0,
              measurements: []
            },
            processingTime: 0
          });
        }
      };
      
      img.src = photo.imageData;
    });
  });
}

/**
 * Master stitching function - sends to backend OpenCV for production quality
 * Includes sensor data and depth maps for accurate stitching and depth-aware blending
 */
export async function stitchSphericalPanorama(
  photos: PanoramaPhoto[],
  onProgress?: (percent: number, message: string) => void
): Promise<StitchedPanorama> {
  console.log('[Stitching] Starting full stitch of', photos.length, 'photos via backend OpenCV');
  
  // Count photos with useful data
  const withSensors = photos.filter(p => p.sensorData).length;
  const withDepth = photos.filter(p => p.depthMap).length;
  console.log(`[Stitching] Sensor data: ${withSensors}/${photos.length}, Depth maps: ${withDepth}/${photos.length}`);
  
  onProgress?.(10, 'Sending to backend for processing...');
  
  try {
    // Create abort controller with 20 minute timeout (depth processing can take 10-15 mins)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20 * 60 * 1000); // 20 minutes
    
    console.log('[Stitching] Request sent with 20-minute timeout...');
    
    // Send to backend for OpenCV stitching with full sensor and depth data
    const response = await fetch('/api/image-stitching/stitch-panorama', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getMobileScanAuthHeaders(),
      },
      body: JSON.stringify({
        photos: photos.map(p => ({
          imageData: p.imageData,
          azimuth: p.azimuth,
          elevation: p.elevation,
          ringIndex: p.ringIndex,
          photoIndex: p.photoIndex,
          // Include sensor data for accurate camera orientation
          sensorData: p.sensorData || null,
          cameraPose: p.cameraPose || null,
          cameraIntrinsics: p.cameraIntrinsics || null,
          // Include depth map for depth-aware blending
          depthMap: p.depthMap ? {
            depthImage: p.depthMap.depthImageData || p.depthMap.depthImageUrl || p.depthMap.depthData,
            minDepth: p.depthMap.minDepth,
            maxDepth: p.depthMap.maxDepth,
          } : null,
        })),
        outputWidth: 4096,
        outputHeight: 2048,
      }),
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Stitching] Backend error:', errorText);
      throw new Error(`Backend stitching failed: ${response.statusText} - ${errorText}`);
    }

    onProgress?.(80, 'Processing completed, preparing viewer...');

    const result = await response.json();
    
    console.log('[Stitching] ✅ Backend returned result:', {
      hasImage: !!result.equirectangularImage,
      imageLength: result.equirectangularImage?.length,
      hasDepthPanorama: !!result.depthPanorama,
      depthRange: result.depthPanorama 
        ? `${result.depthPanorama.minDepth?.toFixed(2)}m - ${result.depthPanorama.maxDepth?.toFixed(2)}m` 
        : 'N/A',
      width: result.width,
      height: result.height,
      processingTime: result.processingTime
    });

    onProgress?.(100, 'Complete');

    // Build result with depth panorama for room measurements
    const stitchedResult: StitchedPanorama = {
      equirectangular: result.equirectangularImage,
      pointCloud: [],
      roomDimensions: {
        width: 0,
        widthMeters: 0,
        widthFeet: 0,
        length: 0,
        lengthMeters: 0,
        lengthFeet: 0,
        height: 0,
        heightMeters: 0,
        heightFeet: 0,
        volume: 0,
        floorArea: 0,
        floorAreaSqM: 0,
        floorAreaSqFt: 0,
        confidence: 0,
        measurements: []
      },
      stitchQuality: result.metadata.blendingMethod === 'multi-band' ? 0.95 : 0.8,
      processingTime: result.processingTime / 1000
    };
    
    // Include room dimensions from depth analysis if available
    if (result.roomDimensions) {
      stitchedResult.roomDimensions = {
        width: result.roomDimensions.widthMeters,
        widthMeters: result.roomDimensions.widthMeters,
        widthFeet: result.roomDimensions.widthFeet,
        length: result.roomDimensions.lengthMeters,
        lengthMeters: result.roomDimensions.lengthMeters,
        lengthFeet: result.roomDimensions.lengthFeet,
        height: result.roomDimensions.heightMeters,
        heightMeters: result.roomDimensions.heightMeters,
        heightFeet: result.roomDimensions.heightFeet,
        volume: result.roomDimensions.widthMeters * result.roomDimensions.lengthMeters * result.roomDimensions.heightMeters,
        floorArea: result.roomDimensions.floorAreaSqM,
        floorAreaSqM: result.roomDimensions.floorAreaSqM,
        floorAreaSqFt: result.roomDimensions.floorAreaSqFt,
        confidence: result.roomDimensions.confidence || 0,
        measurements: []
      };
      console.log('[Stitching] Room dimensions from depth analysis:', 
        `${result.roomDimensions.widthFeet.toFixed(1)}ft × ${result.roomDimensions.lengthFeet.toFixed(1)}ft × ${result.roomDimensions.heightFeet.toFixed(1)}ft`);
    }
    
    // Include depth panorama data if available
    if (result.depthPanorama) {
      stitchedResult.depthPanorama = {
        data: result.depthPanorama.data,
        width: result.depthPanorama.width,
        height: result.depthPanorama.height,
        minDepth: result.depthPanorama.minDepth,
        maxDepth: result.depthPanorama.maxDepth,
        meanDepth: result.depthPanorama.meanDepth,
        medianDepth: result.depthPanorama.medianDepth,
        coverage: result.depthPanorama.coverage,
      };
      console.log('[Stitching] Depth panorama included for room measurements');
    }
    
    // Include point cloud file reference for streaming
    if (result.pointCloudFile) {
      stitchedResult.pointCloudFile = result.pointCloudFile;
      console.log('[Stitching] Point cloud file available for streaming:', result.pointCloudFile);
    }
    
    return stitchedResult;

  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      console.error('[Stitching] Request timed out after 10 minutes');
      throw new Error('Stitching timed out. OpenCV processing took longer than 10 minutes. Try with fewer photos or lower resolution.');
    }
    console.error('[Stitching] Backend stitching failed:', error);
    throw error;
  }
}
