/**
 * Vision Floor Mask Service
 * 
 * Uses Gemini vision to analyze a top-down view of the 3D model
 * and identify exactly which areas are floor vs furniture/objects.
 * Returns a mask that guides texture application.
 */

import * as THREE from 'three';

export interface FloorMaskResult {
  success: boolean;
  maskImageUrl?: string;  // Binary mask: white = floor, black = not floor
  floorRegions?: FloorRegion[];  // Polygon regions describing floor areas
  confidence: number;
  error?: string;
}

export interface FloorRegion {
  // Normalized coordinates (0-1) describing a polygon region
  vertices: { x: number; y: number }[];
  confidence: number;
  description: string;  // e.g., "main floor area", "floor near window"
}

/**
 * Send top-down image to Gemini for floor region identification.
 * Returns a mask showing where the floor actually is.
 */
export async function analyzeFloorRegions(
  topDownImageBase64: string,
  roomContext?: {
    roomType?: string;
    currentFlooring?: string;
    width?: number;
    height?: number;
  }
): Promise<FloorMaskResult> {
  console.log('[VisionFloorMask] Analyzing top-down image for floor regions...');
  
  try {
    const response = await fetch('/api/renovation-preview/analyze-floor-mask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topDownImageBase64,
        roomContext,
        returnMaskImage: true,  // Ask Gemini to generate a binary mask
      }),
    });
    
    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }
    
    const result = await response.json();
    
    if (result.success) {
      console.log('[VisionFloorMask] ✅ Floor mask generated!');
      console.log('[VisionFloorMask] Confidence:', result.confidence);
      if (result.floorRegions) {
        console.log('[VisionFloorMask] Regions found:', result.floorRegions.length);
      }
    }
    
    return result;
  } catch (error) {
    console.error('[VisionFloorMask] Error:', error);
    return {
      success: false,
      confidence: 0,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Check if a point (in normalized 0-1 coords) is within any floor region.
 */
export function isPointInFloorRegion(
  x: number, 
  y: number, 
  regions: FloorRegion[]
): boolean {
  for (const region of regions) {
    if (isPointInPolygon(x, y, region.vertices)) {
      return true;
    }
  }
  return false;
}

/**
 * Ray casting algorithm to check if point is inside polygon.
 */
function isPointInPolygon(
  x: number, 
  y: number, 
  vertices: { x: number; y: number }[]
): boolean {
  let inside = false;
  const n = vertices.length;
  
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = vertices[i].x, yi = vertices[i].y;
    const xj = vertices[j].x, yj = vertices[j].y;
    
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  
  return inside;
}

/**
 * Check if a pixel in the mask image is floor (white) or not (black).
 * This is used when Gemini returns a binary mask image.
 */
export async function checkPixelInMask(
  maskImageUrl: string,
  normalizedX: number,  // 0-1
  normalizedY: number   // 0-1
): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      
      const pixelX = Math.floor(normalizedX * img.width);
      const pixelY = Math.floor(normalizedY * img.height);
      
      const pixel = ctx.getImageData(pixelX, pixelY, 1, 1).data;
      // White (floor) = high values, Black (not floor) = low values
      const brightness = (pixel[0] + pixel[1] + pixel[2]) / 3;
      resolve(brightness > 128);
    };
    img.onerror = () => resolve(false);
    img.src = maskImageUrl;
  });
}

/**
 * Build a lookup table for the mask to avoid repeated image loads.
 */
export async function buildMaskLookup(
  maskImageUrl: string,
  resolution: number = 100  // Grid resolution for lookup
): Promise<boolean[][]> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      
      const lookup: boolean[][] = [];
      
      for (let y = 0; y < resolution; y++) {
        const row: boolean[] = [];
        for (let x = 0; x < resolution; x++) {
          const pixelX = Math.floor((x / resolution) * img.width);
          const pixelY = Math.floor((y / resolution) * img.height);
          
          const pixel = ctx.getImageData(pixelX, pixelY, 1, 1).data;
          const brightness = (pixel[0] + pixel[1] + pixel[2]) / 3;
          row.push(brightness > 128);
        }
        lookup.push(row);
      }
      
      resolve(lookup);
    };
    img.onerror = () => resolve([]);
    img.src = maskImageUrl;
  });
}

/**
 * Check the mask lookup table for a given normalized position.
 */
export function checkMaskLookup(
  lookup: boolean[][],
  normalizedX: number,
  normalizedY: number
): boolean {
  if (lookup.length === 0) return false;
  
  const resolution = lookup.length;
  const x = Math.min(Math.floor(normalizedX * resolution), resolution - 1);
  const y = Math.min(Math.floor(normalizedY * resolution), resolution - 1);
  
  return lookup[y]?.[x] ?? false;
}

/**
 * Project a 3D world position to normalized screen coordinates (0-1).
 * Used to map mesh faces to positions in the mask image.
 */
export function projectToScreen(
  worldPosition: THREE.Vector3,
  camera: THREE.Camera,
  canvasWidth: number,
  canvasHeight: number
): { x: number; y: number } {
  const projected = worldPosition.clone().project(camera);
  
  return {
    x: (projected.x + 1) / 2,
    y: 1 - (projected.y + 1) / 2,  // Flip Y for image coordinates
  };
}

/**
 * Filter mesh faces based on the floor mask.
 * Returns indices of faces that should receive the floor texture.
 */
export async function filterFacesByMask(
  mesh: THREE.Mesh,
  camera: THREE.Camera,
  maskLookup: boolean[][],
  canvasWidth: number,
  canvasHeight: number
): Promise<number[]> {
  const geometry = mesh.geometry as THREE.BufferGeometry;
  const position = geometry.getAttribute('position');
  
  if (!position) return [];
  
  const floorFaceIndices: number[] = [];
  const faceCount = position.count / 3;
  
  for (let i = 0; i < faceCount; i++) {
    // Get face center
    const v0 = new THREE.Vector3().fromBufferAttribute(position, i * 3);
    const v1 = new THREE.Vector3().fromBufferAttribute(position, i * 3 + 1);
    const v2 = new THREE.Vector3().fromBufferAttribute(position, i * 3 + 2);
    
    const center = new THREE.Vector3()
      .add(v0).add(v1).add(v2)
      .divideScalar(3);
    
    // Apply mesh world transform
    center.applyMatrix4(mesh.matrixWorld);
    
    // Project to screen
    const screenPos = projectToScreen(center, camera, canvasWidth, canvasHeight);
    
    // Check if this position is in the floor mask
    if (checkMaskLookup(maskLookup, screenPos.x, screenPos.y)) {
      floorFaceIndices.push(i);
    }
  }
  
  console.log('[VisionFloorMask] Filtered faces:', floorFaceIndices.length, 'of', faceCount, 'are floor');
  
  return floorFaceIndices;
}
