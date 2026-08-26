/**
 * UV Texture Renovation Service
 * 
 * This service solves the 3D renovation projection problem by editing
 * the actual UV-unwrapped texture from the photogrammetry mesh, rather
 * than trying to project 2D AI images onto 3D geometry.
 * 
 * APPROACH:
 * 1. Extract the mesh's original texture atlas (the photogrammetry texture)
 * 2. Generate a UV-space mask for the target surface (floor/wall/etc)
 * 3. Send both to Gemini with an inpainting-style prompt
 * 4. Gemini edits ONLY the masked region in UV space
 * 5. Apply the edited texture back to the mesh
 * 
 * This preserves:
 * - Original lighting and shadows
 * - Room context and furniture
 * - Proper perspective for all viewpoints
 * - No projection distortion
 */

import * as THREE from 'three';
import type { SurfaceSegment, MeshSegmentation } from './meshSegmentationService';

// ============================================================================
// Types
// ============================================================================

export interface UVMask {
  canvas: HTMLCanvasElement;
  imageData: string;  // Base64
  coverage: number;   // 0-1, how much of the texture is masked
  uvBounds: {
    minU: number;
    maxU: number;
    minV: number;
    maxV: number;
  };
}

export interface TextureExtractionResult {
  originalTexture: THREE.Texture;
  textureCanvas: HTMLCanvasElement;
  textureDataUrl: string;
  width: number;
  height: number;
}

export interface UVRenovationRequest {
  mesh: THREE.Mesh;
  segmentation: MeshSegmentation;
  targetSurface: 'floor' | 'wall' | 'ceiling' | 'counter';
  renovationType: string;
  renovationOption: string;
  customPrompt?: string;
}

export interface UVRenovationResult {
  success: boolean;
  originalTexture: THREE.Texture;
  editedTexture: THREE.Texture;
  editedTextureDataUrl: string;
  surfaceMask: UVMask;
}

// ============================================================================
// Step 1: Extract Original Texture from Mesh
// ============================================================================

/**
 * Extract the texture atlas from a photogrammetry mesh.
 * Works with both single-material and multi-material meshes.
 */
export function extractMeshTexture(mesh: THREE.Mesh): TextureExtractionResult | null {
  console.log('[UVRenovation] Extracting mesh texture...');
  
  // Get the material(s)
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  
  // Find the first material with a texture map
  let texture: THREE.Texture | null = null;
  
  for (const mat of materials) {
    if (mat instanceof THREE.MeshStandardMaterial || 
        mat instanceof THREE.MeshBasicMaterial ||
        mat instanceof THREE.MeshPhongMaterial) {
      if (mat.map) {
        texture = mat.map;
        break;
      }
    }
  }
  
  if (!texture || !texture.image) {
    console.error('[UVRenovation] No texture found on mesh');
    return null;
  }
  
  // Draw texture to canvas
  const canvas = document.createElement('canvas');
  const image = texture.image as HTMLImageElement | ImageBitmap;
  canvas.width = image.width || 2048;
  canvas.height = image.height || 2048;
  
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(image, 0, 0);
  
  console.log('[UVRenovation] Texture extracted:', canvas.width, 'x', canvas.height);
  
  return {
    originalTexture: texture,
    textureCanvas: canvas,
    textureDataUrl: canvas.toDataURL('image/jpeg', 0.95),
    width: canvas.width,
    height: canvas.height,
  };
}

// ============================================================================
// Step 2: Generate UV-Space Mask for Surface
// ============================================================================

/**
 * Generate a mask in UV space that covers the specified surface.
 * This mask tells Gemini exactly which parts of the texture to edit.
 */
export function generateUVMask(
  mesh: THREE.Mesh,
  segment: SurfaceSegment,
  textureWidth: number,
  textureHeight: number,
  dilationPx: number = 2 // Slight dilation to prevent seam artifacts
): UVMask | null {
  console.log('[UVRenovation] Generating UV mask for:', segment.type);
  
  const geometry = mesh.geometry as THREE.BufferGeometry;
  const uvAttr = geometry.getAttribute('uv') as THREE.BufferAttribute;
  const indexAttr = geometry.getIndex();
  
  if (!uvAttr) {
    console.error('[UVRenovation] Mesh has no UV coordinates');
    return null;
  }
  
  // Create mask canvas
  const canvas = document.createElement('canvas');
  canvas.width = textureWidth;
  canvas.height = textureHeight;
  const ctx = canvas.getContext('2d')!;
  
  // Start with transparent
  ctx.fillStyle = 'black';
  ctx.fillRect(0, 0, textureWidth, textureHeight);
  
  // Track UV bounds
  let minU = Infinity, maxU = -Infinity;
  let minV = Infinity, maxV = -Infinity;
  
  // Draw white triangles for each face in the segment
  ctx.fillStyle = 'white';
  ctx.strokeStyle = 'white';
  ctx.lineWidth = dilationPx;
  
  for (const faceIndex of segment.faceIndices) {
    // Get UV coordinates for this face
    let i0: number, i1: number, i2: number;
    
    if (indexAttr) {
      i0 = indexAttr.getX(faceIndex * 3);
      i1 = indexAttr.getX(faceIndex * 3 + 1);
      i2 = indexAttr.getX(faceIndex * 3 + 2);
    } else {
      i0 = faceIndex * 3;
      i1 = faceIndex * 3 + 1;
      i2 = faceIndex * 3 + 2;
    }
    
    // Get UV values (0-1 range)
    const u0 = uvAttr.getX(i0), v0 = uvAttr.getY(i0);
    const u1 = uvAttr.getX(i1), v1 = uvAttr.getY(i1);
    const u2 = uvAttr.getX(i2), v2 = uvAttr.getY(i2);
    
    // Track bounds
    minU = Math.min(minU, u0, u1, u2);
    maxU = Math.max(maxU, u0, u1, u2);
    minV = Math.min(minV, v0, v1, v2);
    maxV = Math.max(maxV, v0, v1, v2);
    
    // Convert to pixel coordinates
    // Note: V is typically flipped in UV space
    const px0 = u0 * textureWidth;
    const py0 = (1 - v0) * textureHeight;
    const px1 = u1 * textureWidth;
    const py1 = (1 - v1) * textureHeight;
    const px2 = u2 * textureWidth;
    const py2 = (1 - v2) * textureHeight;
    
    // Draw filled triangle
    ctx.beginPath();
    ctx.moveTo(px0, py0);
    ctx.lineTo(px1, py1);
    ctx.lineTo(px2, py2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke(); // Stroke for dilation
  }
  
  // Calculate coverage
  const imageData = ctx.getImageData(0, 0, textureWidth, textureHeight);
  let whitePixels = 0;
  for (let i = 0; i < imageData.data.length; i += 4) {
    if (imageData.data[i] > 128) whitePixels++;
  }
  const coverage = whitePixels / (textureWidth * textureHeight);
  
  console.log('[UVRenovation] Mask generated - Coverage:', (coverage * 100).toFixed(1) + '%');
  console.log('[UVRenovation] UV bounds:', { minU, maxU, minV, maxV });
  
  return {
    canvas,
    imageData: canvas.toDataURL('image/png'),
    coverage,
    uvBounds: { minU, maxU, minV, maxV },
  };
}

// ============================================================================
// Step 3: Generate Material Texture & Composite
// ============================================================================

/**
 * Material descriptions for tile generation
 */
const materialDescriptions: Record<string, Record<string, string>> = {
  flooring: {
    hardwood: 'seamless oak hardwood flooring texture, natural wood grain, plank patterns, top-down view',
    walnut: 'seamless dark walnut hardwood flooring texture, rich brown tones, elegant grain, top-down view',
    tile: 'seamless large-format porcelain tile texture, light gray, subtle grout lines, top-down view',
    marble: 'seamless white Carrara marble texture, natural gray veining, polished, top-down view',
    vinyl: 'seamless luxury vinyl plank flooring texture, weathered oak style, top-down view',
    carpet: 'seamless neutral beige carpet texture, plush pile, subtle fiber texture, top-down view',
  },
  paint: {
    white: 'seamless clean matte white wall paint texture',
    gray: 'seamless modern light gray wall paint texture',
    beige: 'seamless warm beige wall paint texture',
    navy: 'seamless deep navy blue wall paint texture',
    sage: 'seamless calming sage green wall paint texture',
  },
};

/**
 * Generate a seamless tileable material texture using Gemini.
 * This is much more reliable than asking Gemini to do precise inpainting.
 */
export async function generateMaterialTile(
  renovationType: string,
  renovationOption: string,
  tileSize: number = 512
): Promise<string> {
  console.log('[UVRenovation] Generating material tile:', renovationType, renovationOption);
  
  const materialDesc = materialDescriptions[renovationType]?.[renovationOption] ||
    `seamless ${renovationOption} ${renovationType} texture, tileable, top-down view`;
  
  const prompt = `Generate a perfectly SEAMLESS TILEABLE texture of: ${materialDesc}

REQUIREMENTS:
- The texture MUST tile seamlessly in all directions
- Photorealistic quality
- Even lighting, no strong shadows
- Square format (1:1 aspect ratio)
- Top-down perspective
- High detail
- No text or watermarks
- The edges must blend perfectly when tiled`;

  const response = await fetch('/api/renovation-preview/generate-material-tile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      materialType: renovationType,
      materialOption: renovationOption,
      tileSize,
    }),
  });
  
  if (!response.ok) {
    throw new Error(`Material tile generation failed: ${response.statusText}`);
  }
  
  const result = await response.json();
  
  if (!result.success) {
    throw new Error(result.error || 'Failed to generate material tile');
  }
  
  // If Gemini returned an image, use it
  if (result.tileUrl) {
    console.log('[UVRenovation] ✅ Material tile generated by Gemini');
    return result.tileUrl;
  }
  
  // Fallback: Generate a procedural tile on the client side
  console.log('[UVRenovation] Using procedural fallback tile');
  return generateProceduralTile(renovationType, renovationOption, result.fallbackColor, tileSize);
}

/**
 * Generate a procedural material tile on the client side (fallback when Gemini fails)
 */
function generateProceduralTile(
  materialType: string, 
  materialOption: string, 
  baseColor: string,
  size: number
): string {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  
  // Parse base color
  const color = baseColor || '#C4B8A8';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, size, size);
  
  // Add texture variation based on material type
  if (materialType === 'flooring') {
    // Darken color for grain
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    const grainColor = `rgb(${Math.max(0, r - 40)}, ${Math.max(0, g - 40)}, ${Math.max(0, b - 40)})`;
    
    ctx.fillStyle = grainColor;
    
    if (materialOption === 'tile' || materialOption === 'marble') {
      // Grid pattern for tile/marble
      ctx.lineWidth = 2;
      ctx.strokeStyle = grainColor;
      for (let x = 0; x < size; x += 64) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, size);
        ctx.stroke();
      }
      for (let y = 0; y < size; y += 64) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(size, y);
        ctx.stroke();
      }
    } else {
      // Wood grain pattern
      for (let y = 0; y < size; y += 24) {
        ctx.fillRect(0, y, size, 2);
        // Add variation
        for (let x = 0; x < size; x += 8) {
          if (Math.random() > 0.6) {
            ctx.fillRect(x, y + 4 + Math.random() * 16, 3, 1);
          }
        }
      }
    }
  }
  
  // Add noise for realism
  const imageData = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < imageData.data.length; i += 4) {
    const noise = (Math.random() - 0.5) * 20;
    imageData.data[i] = Math.max(0, Math.min(255, imageData.data[i] + noise));
    imageData.data[i + 1] = Math.max(0, Math.min(255, imageData.data[i + 1] + noise));
    imageData.data[i + 2] = Math.max(0, Math.min(255, imageData.data[i + 2] + noise));
  }
  ctx.putImageData(imageData, 0, 0);
  
  return canvas.toDataURL('image/jpeg', 0.9);
}

/**
 * Analyze the original texture to get average color/brightness in masked area.
 * Used for color matching the new material.
 */
function analyzeTextureRegion(
  textureCanvas: HTMLCanvasElement,
  maskCanvas: HTMLCanvasElement
): { avgR: number; avgG: number; avgB: number; brightness: number } {
  const texCtx = textureCanvas.getContext('2d')!;
  const maskCtx = maskCanvas.getContext('2d')!;
  
  const texData = texCtx.getImageData(0, 0, textureCanvas.width, textureCanvas.height);
  const maskData = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
  
  let sumR = 0, sumG = 0, sumB = 0, count = 0;
  
  // Sample every 4th pixel for performance
  for (let i = 0; i < maskData.data.length; i += 16) {
    if (maskData.data[i] > 128) { // White mask pixel
      const texIdx = i;
      if (texIdx < texData.data.length - 4) {
        sumR += texData.data[texIdx];
        sumG += texData.data[texIdx + 1];
        sumB += texData.data[texIdx + 2];
        count++;
      }
    }
  }
  
  if (count === 0) count = 1;
  
  const avgR = sumR / count;
  const avgG = sumG / count;
  const avgB = sumB / count;
  const brightness = (avgR + avgG + avgB) / 3 / 255;
  
  return { avgR, avgG, avgB, brightness };
}

/**
 * Composite the generated material tile into the masked area of the original texture.
 * This does the actual "inpainting" work that Gemini can't do precisely.
 */
export async function compositeTextureWithMask(
  originalTextureDataUrl: string,
  maskDataUrl: string,
  materialTileDataUrl: string,
  blendEdges: boolean = true
): Promise<string> {
  console.log('[UVRenovation] Compositing material into masked area...');
  
  // Load all images
  const [originalImg, maskImg, tileImg] = await Promise.all([
    loadImage(originalTextureDataUrl),
    loadImage(maskDataUrl),
    loadImage(materialTileDataUrl),
  ]);
  
  const width = originalImg.width;
  const height = originalImg.height;
  
  // Create output canvas
  const outputCanvas = document.createElement('canvas');
  outputCanvas.width = width;
  outputCanvas.height = height;
  const ctx = outputCanvas.getContext('2d')!;
  
  // Draw original texture
  ctx.drawImage(originalImg, 0, 0);
  
  // Create tile pattern
  const patternCanvas = document.createElement('canvas');
  patternCanvas.width = tileImg.width;
  patternCanvas.height = tileImg.height;
  const patternCtx = patternCanvas.getContext('2d')!;
  patternCtx.drawImage(tileImg, 0, 0);
  
  // Analyze original texture colors in masked region for color matching
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = width;
  maskCanvas.height = height;
  const maskCtx = maskCanvas.getContext('2d')!;
  maskCtx.drawImage(maskImg, 0, 0, width, height);
  
  const originalColors = analyzeTextureRegion(outputCanvas, maskCanvas);
  console.log('[UVRenovation] Original region brightness:', originalColors.brightness.toFixed(2));
  
  // Create the tiled material at full texture size
  const tiledCanvas = document.createElement('canvas');
  tiledCanvas.width = width;
  tiledCanvas.height = height;
  const tiledCtx = tiledCanvas.getContext('2d')!;
  
  // Tile the pattern across the full canvas
  const pattern = tiledCtx.createPattern(patternCanvas, 'repeat');
  if (pattern) {
    tiledCtx.fillStyle = pattern;
    tiledCtx.fillRect(0, 0, width, height);
  }
  
  // Color-correct the tiled material to match original lighting
  const tiledData = tiledCtx.getImageData(0, 0, width, height);
  const targetBrightness = originalColors.brightness;
  
  // Analyze tile brightness
  let tileBrightness = 0;
  for (let i = 0; i < tiledData.data.length; i += 4) {
    tileBrightness += (tiledData.data[i] + tiledData.data[i + 1] + tiledData.data[i + 2]) / 3;
  }
  tileBrightness /= (tiledData.data.length / 4) / 255;
  
  // Adjust brightness to match (subtle adjustment)
  const brightnessFactor = 0.7 + 0.3 * (targetBrightness / Math.max(tileBrightness, 0.1));
  const clampedFactor = Math.max(0.6, Math.min(1.4, brightnessFactor));
  
  console.log('[UVRenovation] Brightness adjustment factor:', clampedFactor.toFixed(2));
  
  for (let i = 0; i < tiledData.data.length; i += 4) {
    tiledData.data[i] = Math.min(255, tiledData.data[i] * clampedFactor);
    tiledData.data[i + 1] = Math.min(255, tiledData.data[i + 1] * clampedFactor);
    tiledData.data[i + 2] = Math.min(255, tiledData.data[i + 2] * clampedFactor);
  }
  tiledCtx.putImageData(tiledData, 0, 0);
  
  // Now composite: use mask to blend tiled material into original
  const maskData = maskCtx.getImageData(0, 0, width, height);
  const outputData = ctx.getImageData(0, 0, width, height);
  const tileData = tiledCtx.getImageData(0, 0, width, height);
  
  // Apply mask with optional edge blending
  for (let i = 0; i < maskData.data.length; i += 4) {
    const maskValue = maskData.data[i] / 255; // 0-1
    
    if (maskValue > 0.01) {
      // Blend based on mask (white = 100% new material)
      const blend = blendEdges ? maskValue : (maskValue > 0.5 ? 1 : 0);
      
      outputData.data[i] = outputData.data[i] * (1 - blend) + tileData.data[i] * blend;
      outputData.data[i + 1] = outputData.data[i + 1] * (1 - blend) + tileData.data[i + 1] * blend;
      outputData.data[i + 2] = outputData.data[i + 2] * (1 - blend) + tileData.data[i + 2] * blend;
    }
  }
  
  ctx.putImageData(outputData, 0, 0);
  
  console.log('[UVRenovation] ✅ Compositing complete');
  return outputCanvas.toDataURL('image/jpeg', 0.95);
}

/**
 * Helper to load an image from data URL
 */
function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

/**
 * HYBRID APPROACH: Generate material tile + composite locally
 * This is much more reliable than asking Gemini to do precise inpainting.
 */
export async function editTextureWithGemini(
  textureDataUrl: string,
  maskDataUrl: string,
  renovationType: string,
  renovationOption: string,
  _surfaceType?: string,  // Kept for API compatibility
  _customPrompt?: string  // Kept for API compatibility
): Promise<string> {
  console.log('[UVRenovation] Using hybrid approach: generate tile + local composite');
  
  // Step 1: Generate a seamless material tile with Gemini
  const materialTileDataUrl = await generateMaterialTile(renovationType, renovationOption);
  
  // Step 2: Composite the tile into the masked area locally (no AI needed for this)
  const editedTextureDataUrl = await compositeTextureWithMask(
    textureDataUrl,
    maskDataUrl,
    materialTileDataUrl,
    true // blend edges
  );
  
  return editedTextureDataUrl;
}

// ============================================================================
// Step 4: Apply Edited Texture Back to Mesh
// ============================================================================

/**
 * Create a THREE.js texture from the edited image and apply it to the mesh.
 */
export async function applyEditedTexture(
  mesh: THREE.Mesh,
  editedTextureDataUrl: string
): Promise<THREE.Texture> {
  console.log('[UVRenovation] Applying edited texture to mesh...');
  
  // Load the edited texture
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = reject;
    image.src = editedTextureDataUrl;
  });
  
  const texture = new THREE.Texture(image);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = true;
  texture.needsUpdate = true;
  
  // Apply to mesh material(s)
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  
  for (const mat of materials) {
    if (mat instanceof THREE.MeshStandardMaterial || 
        mat instanceof THREE.MeshBasicMaterial ||
        mat instanceof THREE.MeshPhongMaterial) {
      mat.map = texture;
      mat.needsUpdate = true;
    }
  }
  
  console.log('[UVRenovation] ✅ Edited texture applied successfully');
  
  return texture;
}

// ============================================================================
// Main Orchestration Function
// ============================================================================

/**
 * Complete UV-based renovation pipeline.
 * This is the main entry point for editing mesh textures in place.
 * 
 * NOTE: This only works on triangle meshes with UV coordinates and textures.
 * For Gaussian splats or point clouds, use getViewDependentRenovation instead.
 */
export async function performUVRenovation(
  request: UVRenovationRequest
): Promise<UVRenovationResult> {
  console.log('[UVRenovation] Starting UV-based renovation...');
  console.log('[UVRenovation] Target:', request.targetSurface, '/', request.renovationType, '/', request.renovationOption);
  
  // Check if this is a valid triangle mesh
  const geometry = request.mesh.geometry;
  const positionAttr = geometry?.getAttribute('position');
  const indexAttr = geometry?.getIndex();
  
  // Calculate face count
  let faceCount = 0;
  if (positionAttr) {
    if (indexAttr) {
      faceCount = indexAttr.count / 3;
    } else {
      faceCount = positionAttr.count / 3;
    }
  }
  
  console.log('[UVRenovation] Mesh face count:', faceCount);
  
  if (faceCount === 0) {
    throw new Error(
      'UV renovation requires a triangle mesh with faces. ' +
      'This appears to be a point cloud or Gaussian splat. ' +
      'Please use the AI Tile method or view-dependent projection instead.'
    );
  }
  
  // Check for UV coordinates
  const uvAttr = geometry?.getAttribute('uv');
  if (!uvAttr) {
    throw new Error(
      'UV renovation requires UV coordinates on the mesh. ' +
      'This mesh has no UV mapping. ' +
      'Please use the AI Tile method instead.'
    );
  }
  
  // Step 1: Extract original texture
  const textureExtraction = extractMeshTexture(request.mesh);
  if (!textureExtraction) {
    throw new Error(
      'Failed to extract mesh texture. ' +
      'The mesh may not have a texture applied. ' +
      'Please use the AI Tile method instead.'
    );
  }
  
  // Step 2: Find the target surface segment
  let segments: SurfaceSegment[] = [];
  switch (request.targetSurface) {
    case 'floor':
      segments = request.segmentation.floors;
      break;
    case 'wall':
      segments = request.segmentation.walls;
      break;
    case 'ceiling':
      segments = request.segmentation.ceilings;
      break;
    case 'counter':
      segments = request.segmentation.counters;
      break;
  }
  
  // Log segmentation stats
  console.log('[UVRenovation] Segmentation stats:', {
    floors: request.segmentation.floors.length,
    walls: request.segmentation.walls.length,
    ceilings: request.segmentation.ceilings.length,
    counters: request.segmentation.counters.length,
    totalFaces: request.segmentation.totalFaces,
    segmentedFaces: request.segmentation.segmentedFaces,
  });
  
  if (segments.length === 0) {
    throw new Error(
      `No ${request.targetSurface} segments found in mesh. ` +
      `The mesh has ${faceCount} faces but none were classified as ${request.targetSurface}. ` +
      `Total segmented faces: ${request.segmentation.segmentedFaces}/${request.segmentation.totalFaces}. ` +
      'Try using the AI Tile method instead.'
    );
  }
  
  // Combine all segments of the target type
  const combinedSegment: SurfaceSegment = {
    ...segments[0],
    faceIndices: segments.flatMap(s => s.faceIndices),
    area: segments.reduce((sum, s) => sum + s.area, 0),
  };
  
  // Step 3: Generate UV mask
  const mask = generateUVMask(
    request.mesh,
    combinedSegment,
    textureExtraction.width,
    textureExtraction.height
  );
  
  if (!mask) {
    throw new Error('Failed to generate UV mask');
  }
  
  // Step 4: Send to Gemini for editing
  const editedTextureUrl = await editTextureWithGemini(
    textureExtraction.textureDataUrl,
    mask.imageData,
    request.renovationType,
    request.renovationOption,
    request.targetSurface,
    request.customPrompt
  );
  
  // Step 5: Apply edited texture to mesh
  const editedTexture = await applyEditedTexture(request.mesh, editedTextureUrl);
  
  return {
    success: true,
    originalTexture: textureExtraction.originalTexture,
    editedTexture,
    editedTextureDataUrl: editedTextureUrl,
    surfaceMask: mask,
  };
}

// ============================================================================
// Alternative: View-Dependent Projection
// ============================================================================

/**
 * For cases where UV editing doesn't work well (poor UV unwrapping),
 * this function generates a renovation from the current camera view
 * and projects it as a view-dependent overlay.
 * 
 * The user sees the AI renovation from their current angle, and it
 * updates as they rotate the view (with caching for visited angles).
 */
export interface ViewDependentRenovation {
  cameraPosition: THREE.Vector3;
  cameraTarget: THREE.Vector3;
  renovatedImage: string;
  timestamp: number;
}

const viewCache = new Map<string, ViewDependentRenovation>();

function getViewCacheKey(position: THREE.Vector3, target: THREE.Vector3): string {
  // Quantize to reduce cache size while maintaining smooth transitions
  const quantize = (v: number) => Math.round(v * 10) / 10;
  return `${quantize(position.x)},${quantize(position.y)},${quantize(position.z)}_${quantize(target.x)},${quantize(target.y)},${quantize(target.z)}`;
}

/**
 * Generate or retrieve a view-dependent renovation image.
 * This shows the renovation from exactly the angle the user is viewing.
 */
export async function getViewDependentRenovation(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  renovationType: string,
  renovationOption: string,
  customPrompt?: string
): Promise<ViewDependentRenovation> {
  const position = camera.position.clone();
  const target = new THREE.Vector3();
  camera.getWorldDirection(target).add(position);
  
  const cacheKey = `${renovationType}_${renovationOption}_${getViewCacheKey(position, target)}`;
  
  // Check cache
  const cached = viewCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < 300000) { // 5 min cache
    return cached;
  }
  
  // Capture current view
  renderer.render(scene, camera);
  const imageData = renderer.domElement.toDataURL('image/jpeg', 0.9);
  
  // Send to Gemini for renovation
  const response = await fetch('/api/renovation-preview/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      imageData,
      renovationType,
      renovationOption,
      customPrompt,
    }),
  });
  
  const result = await response.json();
  
  if (!result.success || !result.generatedImageUrl) {
    throw new Error('Failed to generate view-dependent renovation');
  }
  
  const renovation: ViewDependentRenovation = {
    cameraPosition: position,
    cameraTarget: target,
    renovatedImage: result.generatedImageUrl,
    timestamp: Date.now(),
  };
  
  viewCache.set(cacheKey, renovation);
  
  return renovation;
}

/**
 * Clear the view-dependent renovation cache.
 */
export function clearViewCache(): void {
  viewCache.clear();
}
