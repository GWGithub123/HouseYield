/**
 * Enhanced Tile Renovation Service
 * 
 * Improves upon the basic tile method by:
 * 1. Taking a top-down image of the room for context
 * 2. Using Gemini to generate realistic flooring IN the room context
 * 3. Extracting a repeatable flooring pattern from the generated image
 * 4. Applying the pattern with precise plank sizing based on room dimensions
 * 
 * This produces more realistic results because:
 * - Gemini sees the room context and generates appropriate flooring
 * - The pattern extraction ensures seamless tiling
 * - Proper plank sizing matches real-world dimensions
 */

import * as THREE from 'three';
import type { SurfaceSegment } from './meshSegmentationService';
import { captureTopDownView } from './topDownFloorService';

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface FloorboardSpecs {
  plankWidthInches: number;    // Typical: 3", 4", 5", 6", 7", 8"
  plankLengthInches: number;   // Typical: 36", 48", 60", 72", 84"
  grainDirection: 'horizontal' | 'vertical' | 'diagonal';
  staggerPattern: 'random' | 'half-offset' | 'third-offset' | 'none';
}

export interface EnhancedTileRequest {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  meshGroup: THREE.Group;
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  controls: any; // OrbitControls
  segment: SurfaceSegment;
  materialType: string;
  materialOption: string;
  roomDimensions: {
    widthMeters: number;
    lengthMeters: number;
  };
  floorboardSpecs?: FloorboardSpecs;
  worldScale: number;
}

export interface EnhancedTileResult {
  success: boolean;
  tileTextureUrl?: string;
  extractedPatternUrl?: string;
  originalRoomImageUrl?: string;
  generatedRoomImageUrl?: string;
  plankDimensions?: {
    widthMeters: number;
    lengthMeters: number;
  };
  error?: string;
}

// ============================================================================
// Default Floorboard Specifications by Material Type
// ============================================================================

export const DEFAULT_FLOORBOARD_SPECS: Record<string, FloorboardSpecs> = {
  // Hardwood planks - narrower, longer
  'hardwood': {
    plankWidthInches: 5,
    plankLengthInches: 48,
    grainDirection: 'horizontal',
    staggerPattern: 'random',
  },
  'oak': {
    plankWidthInches: 5,
    plankLengthInches: 60,
    grainDirection: 'horizontal',
    staggerPattern: 'random',
  },
  'walnut': {
    plankWidthInches: 6,
    plankLengthInches: 60,
    grainDirection: 'horizontal',
    staggerPattern: 'random',
  },
  // Luxury vinyl planks - wider, shorter
  'vinyl': {
    plankWidthInches: 7,
    plankLengthInches: 48,
    grainDirection: 'horizontal',
    staggerPattern: 'half-offset',
  },
  'lvp': {
    plankWidthInches: 7,
    plankLengthInches: 48,
    grainDirection: 'horizontal',
    staggerPattern: 'half-offset',
  },
  // Engineered hardwood
  'engineered': {
    plankWidthInches: 6,
    plankLengthInches: 72,
    grainDirection: 'horizontal',
    staggerPattern: 'third-offset',
  },
  // Bamboo
  'bamboo': {
    plankWidthInches: 4,
    plankLengthInches: 36,
    grainDirection: 'horizontal',
    staggerPattern: 'random',
  },
  // Tiles (square or rectangular)
  'tile': {
    plankWidthInches: 12,
    plankLengthInches: 24,
    grainDirection: 'horizontal',
    staggerPattern: 'half-offset',
  },
  'porcelain': {
    plankWidthInches: 24,
    plankLengthInches: 24,
    grainDirection: 'horizontal',
    staggerPattern: 'none',
  },
};

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Convert inches to meters
 */
function inchesToMeters(inches: number): number {
  return inches * 0.0254;
}

/**
 * Get floorboard specs for a material option
 */
export function getFloorboardSpecs(materialOption: string): FloorboardSpecs {
  const lowerOption = materialOption.toLowerCase();
  
  // Check for exact match first
  if (DEFAULT_FLOORBOARD_SPECS[lowerOption]) {
    return DEFAULT_FLOORBOARD_SPECS[lowerOption];
  }
  
  // Check for partial match
  for (const [key, specs] of Object.entries(DEFAULT_FLOORBOARD_SPECS)) {
    if (lowerOption.includes(key) || key.includes(lowerOption)) {
      return specs;
    }
  }
  
  // Default to standard hardwood
  return DEFAULT_FLOORBOARD_SPECS['hardwood'];
}

/**
 * Calculate how many planks fit in a room
 */
export function calculatePlankLayout(
  roomWidthMeters: number,
  roomLengthMeters: number,
  specs: FloorboardSpecs
): {
  planksAcrossWidth: number;
  planksAcrossLength: number;
  plankWidthMeters: number;
  plankLengthMeters: number;
  totalPlanks: number;
  coveragePercent: number;
} {
  const plankWidthMeters = inchesToMeters(specs.plankWidthInches);
  const plankLengthMeters = inchesToMeters(specs.plankLengthInches);
  
  // Planks run along the length, so width determines number of rows
  const planksAcrossWidth = Math.ceil(roomWidthMeters / plankWidthMeters);
  const planksAcrossLength = Math.ceil(roomLengthMeters / plankLengthMeters);
  
  const totalPlanks = planksAcrossWidth * planksAcrossLength;
  const coveragePercent = (totalPlanks * plankWidthMeters * plankLengthMeters) / 
                          (roomWidthMeters * roomLengthMeters) * 100;
  
  return {
    planksAcrossWidth,
    planksAcrossLength,
    plankWidthMeters,
    plankLengthMeters,
    totalPlanks,
    coveragePercent,
  };
}

// ============================================================================
// Core Enhanced Tile Generation
// ============================================================================

/**
 * Generate an enhanced floor texture by:
 * 1. Capturing top-down room view
 * 2. Using Gemini to add flooring to the room
 * 3. Extracting a tileable pattern from the result
 */
export async function generateEnhancedFloorTexture(
  request: EnhancedTileRequest,
  onProgress?: (stage: string, progress: number) => void
): Promise<EnhancedTileResult> {
  console.log('[EnhancedTile] Starting enhanced floor texture generation...');
  console.log('[EnhancedTile] Material:', request.materialType, '-', request.materialOption);
  console.log('[EnhancedTile] Room dimensions:', request.roomDimensions.widthMeters.toFixed(2), 'x', 
              request.roomDimensions.lengthMeters.toFixed(2), 'm');
  
  try {
    onProgress?.('Capturing room view...', 0.1);
    
    // 1. Capture top-down view of the room
    const topDownCapture = captureTopDownView(
      request.renderer,
      request.scene,
      request.meshGroup,
      request.camera,
      request.controls,
      1024 // Higher resolution for better detail
    );
    
    console.log('[EnhancedTile] Captured top-down view, bounds:', topDownCapture.bounds);
    
    // 2. Get floorboard specifications
    const specs = request.floorboardSpecs || getFloorboardSpecs(request.materialOption);
    const plankLayout = calculatePlankLayout(
      request.roomDimensions.widthMeters,
      request.roomDimensions.lengthMeters,
      specs
    );
    
    console.log('[EnhancedTile] Plank specs:', specs);
    console.log('[EnhancedTile] Plank layout:', plankLayout);
    
    onProgress?.('Generating floor with AI...', 0.3);
    
    // 3. Send to backend for Gemini processing
    const response = await fetch('/api/renovation-preview/generate-contextual-floor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomImageBase64: topDownCapture.imageDataUrl,
        materialType: request.materialType,
        materialOption: request.materialOption,
        roomDimensions: request.roomDimensions,
        plankSpecs: specs,
        plankLayout: plankLayout,
        extractPattern: true, // Request pattern extraction
      }),
    });
    
    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${response.statusText}`);
    }
    
    const result = await response.json();
    
    if (!result.success) {
      throw new Error(result.error || 'Failed to generate floor texture');
    }
    
    onProgress?.('Floor generated!', 0.8);
    
    console.log('[EnhancedTile] API response received');
    console.log('[EnhancedTile] Has generated room image:', !!result.generatedRoomImageUrl);
    console.log('[EnhancedTile] Has extracted pattern:', !!result.extractedPatternUrl);
    console.log('[EnhancedTile] Has tile texture:', !!result.tileTextureUrl);
    
    onProgress?.('Complete!', 1.0);
    
    return {
      success: true,
      tileTextureUrl: result.tileTextureUrl || result.extractedPatternUrl,
      extractedPatternUrl: result.extractedPatternUrl,
      originalRoomImageUrl: topDownCapture.imageDataUrl,
      generatedRoomImageUrl: result.generatedRoomImageUrl,
      plankDimensions: {
        widthMeters: plankLayout.plankWidthMeters,
        lengthMeters: plankLayout.plankLengthMeters,
      },
    };
    
  } catch (error) {
    console.error('[EnhancedTile] Error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// ============================================================================
// Apply Enhanced Floor Texture to Mesh
// ============================================================================

/**
 * Triplanar shader specifically optimized for plank-based flooring.
 * Takes into account plank dimensions for proper tiling.
 */
const PLANK_FLOOR_VERTEX_SHADER = `
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
  varying vec2 vUv;
  
  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const PLANK_FLOOR_FRAGMENT_SHADER = `
  uniform sampler2D floorTexture;
  uniform sampler2D originalTexture;
  uniform float plankWidthScale;   // World units per plank width
  uniform float plankLengthScale;  // World units per plank length
  uniform float renovationOpacity;
  uniform float hasOriginalTexture;
  uniform float minHeight;
  uniform float maxHeight;
  uniform float grainRotation;     // Rotation of grain direction in radians
  
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
  varying vec2 vUv;
  
  void main() {
    // Height check for floor surfaces only
    float heightFactor = 1.0;
    if (vWorldPosition.y < minHeight || vWorldPosition.y > maxHeight) {
      heightFactor = 0.0;
    }
    
    // Check if this is a floor-facing surface (normal pointing up)
    float floorAlignment = dot(vWorldNormal, vec3(0.0, 1.0, 0.0));
    float isFloor = smoothstep(0.4, 0.6, floorAlignment);
    
    // Apply floor factor
    float showRenovation = isFloor * heightFactor * renovationOpacity;
    
    // Calculate UV coordinates for floor texture with plank scaling
    // Rotate UVs based on grain direction
    float cosR = cos(grainRotation);
    float sinR = sin(grainRotation);
    
    vec2 worldXZ = vWorldPosition.xz;
    vec2 rotatedXZ = vec2(
      worldXZ.x * cosR - worldXZ.y * sinR,
      worldXZ.x * sinR + worldXZ.y * cosR
    );
    
    // Scale based on plank dimensions
    vec2 floorUV = vec2(
      rotatedXZ.x / plankLengthScale,
      rotatedXZ.y / plankWidthScale
    );
    
    vec4 floorColor = texture2D(floorTexture, floorUV);
    
    // Blend with original or fallback
    if (hasOriginalTexture > 0.5) {
      vec4 originalColor = texture2D(originalTexture, vUv);
      gl_FragColor = mix(originalColor, floorColor, showRenovation);
    } else {
      vec4 fallbackColor = vec4(0.7, 0.7, 0.7, 1.0);
      gl_FragColor = mix(fallbackColor, floorColor, showRenovation);
    }
  }
`;

export interface ApplyEnhancedFloorRequest {
  mesh: THREE.Mesh;
  segment: SurfaceSegment;
  textureUrl: string;
  plankDimensions: {
    widthMeters: number;
    lengthMeters: number;
  };
  worldScale: number;
  grainDirection?: 'horizontal' | 'vertical' | 'diagonal';
}

export async function applyEnhancedFloorTexture(
  request: ApplyEnhancedFloorRequest
): Promise<{ success: boolean; restore: () => void; error?: string }> {
  const { mesh, textureUrl, plankDimensions, worldScale, grainDirection = 'horizontal' } = request;
  
  console.log('[EnhancedTile] Applying floor texture with plank sizing...');
  console.log('[EnhancedTile] Plank dimensions:', plankDimensions.widthMeters.toFixed(3), 'x', 
              plankDimensions.lengthMeters.toFixed(3), 'm');
  console.log('[EnhancedTile] World scale:', worldScale);
  
  try {
    // Get original texture if available
    const originalMaterial = mesh.material as THREE.Material & { map?: THREE.Texture | null };
    let originalTexture: THREE.Texture | null = originalMaterial?.map || null;
    
    if (!originalTexture) {
      // Create placeholder
      const placeholderCanvas = document.createElement('canvas');
      placeholderCanvas.width = placeholderCanvas.height = 1;
      const ctx = placeholderCanvas.getContext('2d')!;
      ctx.fillStyle = '#888888';
      ctx.fillRect(0, 0, 1, 1);
      originalTexture = new THREE.CanvasTexture(placeholderCanvas);
    }
    
    // Load floor texture
    const floorTexture = await new Promise<THREE.Texture>((resolve, reject) => {
      new THREE.TextureLoader().load(
        textureUrl,
        (tex) => {
          tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.minFilter = THREE.LinearMipmapLinearFilter;
          tex.magFilter = THREE.LinearFilter;
          tex.generateMipmaps = true;
          resolve(tex);
        },
        undefined,
        reject
      );
    });
    
    // Calculate grain rotation
    let grainRotation = 0;
    if (grainDirection === 'vertical') {
      grainRotation = Math.PI / 2;
    } else if (grainDirection === 'diagonal') {
      grainRotation = Math.PI / 4;
    }
    
    // Create shader material
    const shaderMaterial = new THREE.ShaderMaterial({
      uniforms: {
        floorTexture: { value: floorTexture },
        originalTexture: { value: originalTexture },
        plankWidthScale: { value: plankDimensions.widthMeters * worldScale },
        plankLengthScale: { value: plankDimensions.lengthMeters * worldScale },
        renovationOpacity: { value: 1.0 },
        hasOriginalTexture: { value: originalMaterial?.map ? 1.0 : 0.0 },
        minHeight: { value: -0.5 },
        maxHeight: { value: 0.3 },
        grainRotation: { value: grainRotation },
      },
      vertexShader: PLANK_FLOOR_VERTEX_SHADER,
      fragmentShader: PLANK_FLOOR_FRAGMENT_SHADER,
      side: THREE.DoubleSide,
    });
    
    // Store and replace material
    const savedMaterial = mesh.material;
    mesh.material = shaderMaterial;
    
    console.log('[EnhancedTile] ✅ Enhanced floor texture applied');
    
    return {
      success: true,
      restore: () => {
        mesh.material = savedMaterial;
        shaderMaterial.dispose();
        floorTexture.dispose();
        console.log('[EnhancedTile] Restored original material');
      },
    };
    
  } catch (error) {
    console.error('[EnhancedTile] Error applying texture:', error);
    return {
      success: false,
      restore: () => {},
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// ============================================================================
// Full Pipeline: Generate + Apply
// ============================================================================

export async function performEnhancedTileRenovation(
  request: EnhancedTileRequest,
  onProgress?: (stage: string, progress: number) => void
): Promise<{ success: boolean; restore: () => void; error?: string }> {
  console.log('[EnhancedTile] Starting full enhanced tile renovation pipeline...');
  
  // Generate the texture
  const generateResult = await generateEnhancedFloorTexture(request, (stage, progress) => {
    onProgress?.(stage, progress * 0.7); // First 70%
  });
  
  if (!generateResult.success || !generateResult.tileTextureUrl) {
    return {
      success: false,
      restore: () => {},
      error: generateResult.error || 'No texture generated',
    };
  }
  
  onProgress?.('Applying to 3D mesh...', 0.8);
  
  // Find the main mesh in the group
  let targetMesh: THREE.Mesh | null = null;
  request.meshGroup.traverse((child) => {
    if (child instanceof THREE.Mesh && !targetMesh) {
      targetMesh = child;
    }
  });
  
  if (!targetMesh) {
    return {
      success: false,
      restore: () => {},
      error: 'No mesh found in group',
    };
  }
  
  // Apply the texture
  const applyResult = await applyEnhancedFloorTexture({
    mesh: targetMesh,
    segment: request.segment,
    textureUrl: generateResult.tileTextureUrl,
    plankDimensions: generateResult.plankDimensions || {
      widthMeters: 0.127, // 5 inches default
      lengthMeters: 1.22,  // 48 inches default
    },
    worldScale: request.worldScale,
    grainDirection: request.floorboardSpecs?.grainDirection,
  });
  
  onProgress?.('Complete!', 1.0);
  
  return applyResult;
}
