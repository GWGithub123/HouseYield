/**
 * AI Texture Generation Service
 * 
 * Uses Google Gemini to generate realistic material textures that can be applied
 * to 3D mesh segments. Supports:
 * - Real-world dimension-aware texture generation
 * - Segment-specific textures (floor, wall, counter)
 * - Seamless tileable textures
 * - Proper UV scaling for accurate visualization
 */

import * as THREE from 'three';

// ============================================================================
// Types
// ============================================================================

export interface SegmentDimensions {
  width: number;    // In meters
  height: number;   // In meters
  area: number;     // In square meters
}

export interface TextureGenerationRequest {
  segmentImage: string;           // Base64 image of the segment
  segmentType: 'floor' | 'wall' | 'ceiling' | 'counter';
  renovationType: 'flooring' | 'paint' | 'countertop';
  renovationOption: string;       // 'hardwood', 'tile', 'white', etc.
  dimensions: SegmentDimensions;  // Real-world measurements
  customPrompt?: string;
}

export interface GeneratedTexture {
  textureUrl: string;             // URL to the generated texture
  textureDataUrl?: string;        // Base64 data URL (for immediate use)
  realWorldScale: {
    width: number;
    height: number;
  };
  generatedAt: string;
  prompt: string;
  segmentType: string;
}

// ============================================================================
// Texture Cache
// ============================================================================

const textureCache = new Map<string, GeneratedTexture>();

function getCacheKey(request: TextureGenerationRequest): string {
  return `${request.segmentType}_${request.renovationType}_${request.renovationOption}_${request.dimensions.width.toFixed(2)}x${request.dimensions.height.toFixed(2)}`;
}

// ============================================================================
// Prompt Generation
// ============================================================================

/**
 * Generate a detailed prompt for Gemini to create a realistic texture
 */
function generateTexturePrompt(request: TextureGenerationRequest): string {
  const { segmentType, renovationType, renovationOption, dimensions } = request;
  
  if (request.customPrompt) {
    return request.customPrompt;
  }
  
  const basePrompts: Record<string, Record<string, string>> = {
    flooring: {
      hardwood: `realistic oak hardwood flooring planks with natural wood grain variation`,
      walnut: `rich dark walnut hardwood flooring with deep brown tones`,
      tile: `modern large-format porcelain tile in light gray with subtle texture`,
      marble: `elegant white Carrara marble with gray veining`,
      vinyl: `luxury vinyl plank flooring in weathered oak style`,
      carpet: `plush neutral-toned carpet with subtle weave pattern`,
    },
    paint: {
      white: `clean matte white wall paint with slight texture`,
      gray: `modern light gray wall paint`,
      beige: `warm beige wall paint`,
      navy: `deep navy blue wall paint`,
      sage: `calming sage green wall paint`,
    },
    countertop: {
      granite: `polished black granite with natural stone patterns`,
      quartz: `white quartz with subtle gray veining`,
      marble: `Carrara marble with elegant gray veining`,
      butcher_block: `warm butcher block wood with visible grain`,
      laminate: `modern white laminate countertop`,
    },
  };
  
  const materialDescription = basePrompts[renovationType]?.[renovationOption] || 
    `${renovationOption} ${renovationType} material`;
  
  // Calculate material-specific details
  let materialDetails = '';
  if (renovationType === 'flooring' && renovationOption === 'hardwood') {
    const plankWidth = 0.15; // 6 inches in meters
    const plankLength = 1.8;  // 6 feet in meters
    const planksNeeded = Math.ceil((dimensions.area / plankLength) / plankWidth);
    materialDetails = `
The texture must show exactly ${planksNeeded} hardwood planks to cover ${dimensions.area.toFixed(1)} square meters.
Standard plank dimensions: ${plankWidth}m (6") wide × ${plankLength}m (6') long.
Show natural wood grain running lengthwise along each plank.`;
  } else if (renovationType === 'flooring' && renovationOption.includes('tile')) {
    const tileSize = 0.6; // 24 inches
    const tilesNeeded = Math.ceil(dimensions.area / (tileSize * tileSize));
    materialDetails = `
The texture must show approximately ${tilesNeeded} tiles to cover ${dimensions.area.toFixed(1)} square meters.
Tile size: ${tileSize}m × ${tileSize}m (24" × 24").
Show subtle grout lines between tiles.`;
  } else if (renovationType === 'paint') {
    materialDetails = `
Show a uniform wall surface with realistic paint texture.
Include subtle wall texture and natural lighting variations.`;
  } else if (renovationType === 'countertop') {
    materialDetails = `
Show a smooth countertop surface with realistic material patterns.
Include natural variations and proper reflective properties.`;
  }
  
  const viewAngle = segmentType === 'floor' || segmentType === 'counter' 
    ? 'from directly above (orthographic top-down view)'
    : 'from directly in front (orthographic straight-on view)';
  
  return `Generate a photorealistic ${materialDescription} texture that covers exactly ${dimensions.width.toFixed(2)} meters × ${dimensions.height.toFixed(2)} meters (${dimensions.area.toFixed(1)} square meters).

${materialDetails}

CRITICAL REQUIREMENTS:
- View ${viewAngle}
- NO perspective distortion - perfectly flat orthographic projection
- SEAMLESSLY TILEABLE on all edges (for texture wrapping)
- Photorealistic with proper lighting and shadows
- Show ONLY the ${segmentType} material surface
- NO walls, furniture, or other objects
- NO borders, labels, or text
- Natural material variations and patterns
- Proper scale showing realistic material size

Return a clean, seamlessly tileable texture image suitable for 3D mesh application.`;
}

// ============================================================================
// Main Generation Function
// ============================================================================

/**
 * Generate a texture using Gemini AI
 */
export async function generateAITexture(
  request: TextureGenerationRequest
): Promise<GeneratedTexture> {
  // Check cache first
  const cacheKey = getCacheKey(request);
  const cached = textureCache.get(cacheKey);
  if (cached) {
    console.log('[AITexture] Using cached texture:', cacheKey);
    return cached;
  }
  
  console.log('[AITexture] Generating new texture:', cacheKey);
  
  const prompt = generateTexturePrompt(request);
  
  try {
    const response = await fetch('/api/textures/generate-texture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        segmentImage: request.segmentImage,
        segmentType: request.segmentType,
        renovationType: request.renovationType,
        renovationOption: request.renovationOption,
        dimensions: request.dimensions,
        prompt,
        useProModel: true, // Use Nano Banana Pro for better quality
      }),
    });
    
    if (!response.ok) {
      throw new Error(`Texture generation failed: ${response.statusText}`);
    }
    
    const result = await response.json();
    console.log('[AITexture] API response:', result);
    
    if (!result.success) {
      throw new Error(result.error || result.details || 'Texture generation failed');
    }
    
    // Build full URL for texture if it's a relative path
    let textureUrl = result.textureUrl || result.generatedImageUrl;
    if (textureUrl && textureUrl.startsWith('/')) {
      textureUrl = window.location.origin.replace(':5173', ':3001') + textureUrl;
    }
    
    const generatedTexture: GeneratedTexture = {
      textureUrl: textureUrl,
      textureDataUrl: result.textureDataUrl,
      realWorldScale: {
        width: request.dimensions.width,
        height: request.dimensions.height,
      },
      generatedAt: new Date().toISOString(),
      prompt,
      segmentType: request.segmentType,
    };
    
    console.log('[AITexture] Generated texture object:', generatedTexture);
    
    // Cache the result
    textureCache.set(cacheKey, generatedTexture);
    
    return generatedTexture;
  } catch (error) {
    console.error('[AITexture] Generation failed:', error);
    throw error;
  }
}

// ============================================================================
// Texture Application Helpers
// ============================================================================

/**
 * Load a generated texture into THREE.js
 */
export async function loadTextureForThreeJS(
  generatedTexture: GeneratedTexture
): Promise<THREE.Texture> {
  // Prefer base64 data URL if available, otherwise use the server URL
  const textureUrl = generatedTexture.textureDataUrl || generatedTexture.textureUrl;
  
  console.log('[AITexture] Loading texture from:', textureUrl?.substring(0, 100) + '...');
  
  if (!textureUrl) {
    throw new Error('No texture URL available');
  }
  
  // First, load the image and wait for it to fully decode
  const image = new Image();
  image.crossOrigin = 'anonymous';
  
  await new Promise<void>((resolve, reject) => {
    image.onload = async () => {
      // Wait for image to be decoded
      try {
        await image.decode();
        console.log('[AITexture] Image decoded successfully:', image.width, 'x', image.height);
        resolve();
      } catch (e) {
        // decode() might not be supported in all browsers, but image is loaded
        console.log('[AITexture] Image loaded (decode skipped):', image.width, 'x', image.height);
        resolve();
      }
    };
    image.onerror = (e) => {
      console.error('[AITexture] Image failed to load:', e);
      reject(new Error('Failed to load texture image'));
    };
    image.src = textureUrl;
  });
  
  // Create texture from the loaded image
  const texture = new THREE.Texture(image);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  
  console.log('[AITexture] ✅ Texture created with image:', texture.image?.width, 'x', texture.image?.height);
  
  return texture;
}

/**
 * Calculate UV repeat values based on real-world dimensions
 */
export function calculateUVRepeat(
  segmentSize: { width: number; height: number },
  textureSize: { width: number; height: number }
): { x: number; y: number } {
  return {
    x: segmentSize.width / textureSize.width,
    y: segmentSize.height / textureSize.height,
  };
}

// ============================================================================
// Segment Capture
// ============================================================================

/**
 * Capture a view of a specific mesh segment for texture generation
 */
export function captureSegmentImage(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  segment: { bounds: { center: THREE.Vector3; size: THREE.Vector3 } },
  segmentType: 'floor' | 'wall' | 'ceiling' | 'counter'
): string {
  // Create temporary camera for orthographic capture
  const camera = new THREE.OrthographicCamera(
    -segment.bounds.size.x / 2,
    segment.bounds.size.x / 2,
    segment.bounds.size.y / 2,
    -segment.bounds.size.y / 2,
    0.1,
    1000
  );
  
  // Position camera based on segment type
  const center = segment.bounds.center;
  if (segmentType === 'floor') {
    // Top-down view
    camera.position.set(center.x, center.y + 5, center.z);
    camera.lookAt(center);
  } else if (segmentType === 'ceiling') {
    // Bottom-up view
    camera.position.set(center.x, center.y - 5, center.z);
    camera.lookAt(center);
  } else if (segmentType === 'wall') {
    // Straight-on view
    camera.position.set(center.x, center.y, center.z + 5);
    camera.lookAt(center);
  } else if (segmentType === 'counter') {
    // Top-down view (similar to floor)
    camera.position.set(center.x, center.y + 3, center.z);
    camera.lookAt(center);
  }
  
  // Render to capture
  const originalCamera = scene.userData.currentCamera;
  renderer.render(scene, camera);
  const imageData = renderer.domElement.toDataURL('image/jpeg', 0.9);
  
  // Restore original camera
  if (originalCamera) {
    renderer.render(scene, originalCamera);
  }
  
  return imageData;
}

// ============================================================================
// Cache Management
// ============================================================================

export function clearTextureCache(): void {
  textureCache.clear();
  console.log('[AITexture] Cache cleared');
}

export function getTextureFromCache(request: TextureGenerationRequest): GeneratedTexture | null {
  const cacheKey = getCacheKey(request);
  return textureCache.get(cacheKey) || null;
}
