/**
 * Triplanar Renovation Service
 * 
 * Applies AI-generated renovation textures to 3D meshes using triplanar projection.
 * This solves the fundamental problem with the OpenMVS approach:
 * 
 * THE PROBLEM WITH OPENMVS:
 * - OpenMVS TextureMesh is designed for photogrammetry where all input images
 *   are photos of the SAME real-world scene
 * - Gemini generates INDEPENDENT 2D renovations for each view
 * - These don't have 3D consistency (flooring patterns don't align)
 * - Result: fragmented triangles with misaligned textures
 * 
 * THE SOLUTION - TRIPLANAR PROJECTION:
 * 1. Generate a SINGLE seamless tileable texture with Gemini (just the material)
 * 2. Apply it to the mesh segment using world-space triplanar mapping
 * 3. Blend with original texture based on surface normal orientation
 * 
 * BENEFITS:
 * ✅ Looks correct from ALL viewing angles
 * ✅ No inconsistency between views
 * ✅ Real-time (no GCP GPU needed)
 * ✅ Preserves original photogrammetry geometry
 * ✅ Material scales correctly to real-world dimensions
 */

import * as THREE from 'three';
import type { SurfaceSegment } from './meshSegmentationService';

// ============================================================================
// Types
// ============================================================================

export interface RenovationMaterial {
  name: string;
  type: 'flooring' | 'paint' | 'wallpaper' | 'tile' | 'countertop';
  textureUrl?: string;
  color?: string;
  roughness?: number;
  metalness?: number;
  bumpScale?: number;
  repeatX: number;  // How many times to tile in X (world units per repeat)
  repeatY: number;  // How many times to tile in Y (world units per repeat)
}

export interface TriplanarRenovationRequest {
  mesh: THREE.Mesh;
  segment: SurfaceSegment;
  material: RenovationMaterial;
  worldScale: number;  // Scale factor from calibration (units per meter)
  blendSharpness?: number;  // How sharp the triplanar blend is (default 4.0)
  floorMaskTexture?: THREE.Texture | null;  // Vision-based mask: white = floor, black = not floor
}

export interface TriplanarRenovationResult {
  success: boolean;
  shaderMaterial: THREE.ShaderMaterial | null;
  restore: () => void;  // Function to restore original material
  error?: string;
}

// ============================================================================
// Triplanar Shader
// ============================================================================

const TRIPLANAR_VERTEX_SHADER = `
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
  varying vec2 vUv;
  
  void main() {
    // Transform to world space for triplanar mapping
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    
    // World-space normal for blend weights
    vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
    
    // Keep original UVs for blending with original texture
    vUv = uv;
    
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Triplanar fragment shader with original texture blending and vision mask support
const TRIPLANAR_FRAGMENT_SHADER = `
  uniform sampler2D renovationTexture;
  uniform sampler2D originalTexture;
  uniform sampler2D floorMaskTexture;
  uniform float textureScale;  // World units per texture repeat
  uniform float blendSharpness;
  uniform float renovationOpacity;  // 0 = original, 1 = fully renovated
  uniform vec3 primaryAxis;  // Which axis this surface primarily faces (e.g., Y for floor)
  uniform float surfaceThreshold;  // How aligned normal must be to apply renovation
  uniform float hasOriginalTexture;  // 1.0 if we have original, 0.0 if not
  uniform float minHeight;  // Minimum Y height for renovation (for floor = low values)
  uniform float maxHeight;  // Maximum Y height for renovation (for floor = low values)
  uniform float useFloorMask;  // 1.0 if using vision-based floor mask
  uniform vec3 meshBoundsMin;  // Mesh bounding box min for mask UV calculation
  uniform vec3 meshBoundsMax;  // Mesh bounding box max for mask UV calculation
  
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
  varying vec2 vUv;
  
  void main() {
    // VISION MASK CHECK: If we have a floor mask from AI vision, use it
    float maskFactor = 1.0;
    if (useFloorMask > 0.5) {
      // Calculate UV for mask based on world XZ position within mesh bounds
      vec2 maskUV = vec2(
        (vWorldPosition.x - meshBoundsMin.x) / (meshBoundsMax.x - meshBoundsMin.x),
        (vWorldPosition.z - meshBoundsMin.z) / (meshBoundsMax.z - meshBoundsMin.z)
      );
      maskUV = clamp(maskUV, 0.0, 1.0);
      
      // Sample the mask - white (1.0) = floor, black (0.0) = not floor
      float maskValue = texture2D(floorMaskTexture, maskUV).r;
      maskFactor = step(0.5, maskValue);  // Binary threshold
    }
    
    // HEIGHT CHECK: Only apply renovation within height range (fallback when no mask)
    float heightFactor = 1.0;
    if (useFloorMask < 0.5) {
      // Only use height check if we don't have a vision mask
      if (vWorldPosition.y < minHeight || vWorldPosition.y > maxHeight) {
        heightFactor = 0.0;  // Outside height range - don't apply renovation
      }
    }
    
    // Combine mask and height factors
    float spatialFactor = useFloorMask > 0.5 ? maskFactor : heightFactor;
    
    // Calculate blend weights based on normal direction
    vec3 blendWeights = abs(vWorldNormal);
    blendWeights = pow(blendWeights, vec3(blendSharpness));
    blendWeights = blendWeights / (blendWeights.x + blendWeights.y + blendWeights.z);
    
    // Sample renovation texture from three projections
    vec2 uvX = vWorldPosition.zy * textureScale;
    vec2 uvY = vWorldPosition.xz * textureScale;
    vec2 uvZ = vWorldPosition.xy * textureScale;
    
    vec4 texX = texture2D(renovationTexture, uvX);
    vec4 texY = texture2D(renovationTexture, uvY);
    vec4 texZ = texture2D(renovationTexture, uvZ);
    
    // Blend based on normal direction
    vec4 renovatedColor = texX * blendWeights.x + texY * blendWeights.y + texZ * blendWeights.z;
    
    // Determine how much this fragment should show the renovation
    // Based on how aligned the normal is with the primary axis AND spatial check
    float axisAlignment = abs(dot(vWorldNormal, primaryAxis));
    float showRenovation = smoothstep(surfaceThreshold - 0.1, surfaceThreshold + 0.1, axisAlignment);
    showRenovation *= spatialFactor;  // Apply spatial restriction (mask or height)
    
    // If we have original texture, blend with it. Otherwise just show renovation on aligned surfaces.
    if (hasOriginalTexture > 0.5) {
      // Sample original texture
      vec4 originalColor = texture2D(originalTexture, vUv);
      
      // Final blend: if surface faces the right way AND passes spatial check, show renovation
      float finalBlend = showRenovation * renovationOpacity;
      gl_FragColor = mix(originalColor, renovatedColor, finalBlend);
    } else {
      // No original texture - show renovation on aligned surfaces, gray elsewhere
      vec4 fallbackColor = vec4(0.7, 0.7, 0.7, 1.0); // Light gray for non-renovated areas
      float finalBlend = showRenovation * renovationOpacity;
      gl_FragColor = mix(fallbackColor, renovatedColor, finalBlend);
    }
  }
`;

// ============================================================================
// Texture Generation with Gemini
// ============================================================================

/**
 * Generate a seamless tileable renovation texture using Gemini.
 * This generates JUST the material pattern, not a scene view.
 */
export async function generateSeamlessTileTexture(
  materialType: string,
  materialOption: string,
  tileSizeMeters: { width: number; height: number }
): Promise<{ textureUrl: string; success: boolean; error?: string; fallbackColor?: string }> {
  console.log('[TriplanarRenovation] Generating seamless tile texture...');
  console.log('[TriplanarRenovation] Material:', materialType, '-', materialOption);
  console.log('[TriplanarRenovation] Tile size:', tileSizeMeters.width, 'x', tileSizeMeters.height, 'm');
  
  try {
    const response = await fetch('/api/renovation-preview/generate-tile-texture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        materialType,
        materialOption,
        tileSizeMeters,
        seamless: true,
      }),
    });
    
    if (!response.ok) {
      console.warn('[TriplanarRenovation] API request failed:', response.status, response.statusText);
      // Return a fallback color for client-side generation
      return generateFallbackTexture(materialType, materialOption);
    }
    
    const result = await response.json();
    console.log('[TriplanarRenovation] API response:', result.success ? 'success' : 'failed', 
                result.usedFallback ? '(used fallback)' : '(from Gemini)');
    console.log('[TriplanarRenovation] Texture URL type:', result.textureUrl ? 
                (result.textureUrl.startsWith('data:') ? 'data URL' : 'file URL') : 'null');
    console.log('[TriplanarRenovation] Texture URL length:', result.textureUrl?.length || 0);
    
    if (result.success && result.textureUrl) {
      console.log('[TriplanarRenovation] ✅ Got texture URL from API:', 
                  result.textureUrl.substring(0, 100) + '...');
      return {
        success: true,
        textureUrl: result.textureUrl,
      };
    }
    
    // API returned success but no texture - use fallback color
    if (result.fallbackColor) {
      console.log('[TriplanarRenovation] Using fallback color from API:', result.fallbackColor);
      return {
        success: true,
        textureUrl: '', // Will be generated client-side
        fallbackColor: result.fallbackColor,
      };
    }
    
    console.warn('[TriplanarRenovation] API failed, using client-side fallback');
    return generateFallbackTexture(materialType, materialOption);
    
  } catch (error) {
    console.error('[TriplanarRenovation] Texture generation error:', error);
    // Network error - generate fallback client-side
    return generateFallbackTexture(materialType, materialOption);
  }
}

/**
 * Generate a fallback texture client-side when API is unavailable
 */
function generateFallbackTexture(
  materialType: string,
  materialOption: string
): { textureUrl: string; success: boolean; fallbackColor?: string } {
  console.log('[TriplanarRenovation] Generating fallback texture client-side');
  
  // Material color mapping
  // Use LIGHTER colors for better visibility - the shader doesn't have lighting
  const colors: Record<string, Record<string, string>> = {
    flooring: {
      hardwood: '#C9A66B',  // Lighter golden wood
      walnut: '#A67B5B',    // Lighter walnut (was too dark)
      oak: '#DEB887',       // Burlywood - light oak
      tile: '#E8E8E8',
      marble: '#F5F5F5',
      carpet: '#B8A080',
      vinyl: '#C8B090',
    },
    paint: {
      white: '#FAFAFA',
      gray: '#B0B8C0',
      beige: '#E5D5C5',
      navy: '#4A6080',
      sage: '#A8C898',
    }
  };
  
  const color = colors[materialType]?.[materialOption.toLowerCase()] || 
                colors[materialType]?.['hardwood'] || 
                '#9C7A4A';
  
  console.log('[TriplanarRenovation] Fallback color:', color);
  
  return {
    success: true,
    textureUrl: '',
    fallbackColor: color,
  };
}

// ============================================================================
// Apply Renovation to Mesh Segment
// ============================================================================

/**
 * Apply a renovation texture to a mesh segment using triplanar projection.
 * This keeps the original geometry and just changes how the texture is applied.
 */
export async function applyTriplanarRenovation(
  request: TriplanarRenovationRequest
): Promise<TriplanarRenovationResult> {
  const { mesh, segment, material, worldScale, blendSharpness = 4.0, floorMaskTexture } = request;
  
  console.log('[TriplanarRenovation] Applying renovation to segment:', segment.type);
  console.log('[TriplanarRenovation] World scale:', worldScale, 'units/m');
  console.log('[TriplanarRenovation] Segment bounds:', segment.bounds);
  if (floorMaskTexture) {
    console.log('[TriplanarRenovation] 🎯 Vision-based floor mask provided');
  }
  
  try {
    // Get original material for restoration and blending
    // Support MeshPhongMaterial, MeshStandardMaterial, MeshBasicMaterial
    const originalMaterial = mesh.material as THREE.Material & { map?: THREE.Texture | null };
    let originalTexture: THREE.Texture | null = null;
    
    // Try to get the texture from various material types
    if ('map' in originalMaterial && originalMaterial.map) {
      originalTexture = originalMaterial.map;
      console.log('[TriplanarRenovation] Found original texture from material.map');
    } else if (mesh.userData?.originalTexture) {
      // Check userData (sometimes stored there during loading)
      originalTexture = mesh.userData.originalTexture;
      console.log('[TriplanarRenovation] Found original texture from userData');
    }
    
    // Track whether we have an original texture
    const hasOriginalTexture = originalTexture !== null;
    
    if (!originalTexture) {
      console.warn('[TriplanarRenovation] No original texture found - will use fallback for non-renovated areas');
      console.log('[TriplanarRenovation] Material type:', originalMaterial.type);
      
      // Create a placeholder 1x1 gray texture for the shader (it won't be used but shader needs something)
      const placeholderCanvas = document.createElement('canvas');
      placeholderCanvas.width = placeholderCanvas.height = 1;
      const ctx = placeholderCanvas.getContext('2d')!;
      ctx.fillStyle = '#888888';
      ctx.fillRect(0, 0, 1, 1);
      originalTexture = new THREE.CanvasTexture(placeholderCanvas);
    } else {
      console.log('[TriplanarRenovation] Original texture:', originalTexture);
      console.log('[TriplanarRenovation] Original texture image loaded:', !!originalTexture.image);
    }
    
    // Load the renovation texture
    let renovationTexture: THREE.Texture;
    
    if (material.textureUrl) {
      // Load from URL
      renovationTexture = await new Promise<THREE.Texture>((resolve, reject) => {
        new THREE.TextureLoader().load(
          material.textureUrl!,
          (tex) => {
            tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
            tex.colorSpace = THREE.SRGBColorSpace;
            resolve(tex);
          },
          undefined,
          reject
        );
      });
    } else if (material.color) {
      // Create solid color texture
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 64;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = material.color;
      ctx.fillRect(0, 0, 64, 64);
      renovationTexture = new THREE.CanvasTexture(canvas);
      renovationTexture.wrapS = renovationTexture.wrapT = THREE.RepeatWrapping;
    } else {
      return {
        success: false,
        shaderMaterial: null,
        restore: () => {},
        error: 'Material has no texture or color',
      };
    }
    
    // Determine primary axis based on surface type
    let primaryAxis: THREE.Vector3;
    switch (segment.type) {
      case 'floor':
        primaryAxis = new THREE.Vector3(0, 1, 0);  // Floor faces up
        break;
      case 'ceiling':
        primaryAxis = new THREE.Vector3(0, -1, 0);  // Ceiling faces down
        break;
      case 'wall':
        // Use average normal of wall segment
        primaryAxis = segment.normal.clone();
        break;
      default:
        primaryAxis = segment.normal.clone();
    }
    
    // Calculate texture scale based on world scale and material repeat settings
    // textureScale = how many texture repeats per world unit
    const textureScale = 1.0 / (material.repeatX * worldScale);
    
    console.log('[TriplanarRenovation] Texture scale:', textureScale);
    console.log('[TriplanarRenovation] Has original texture:', hasOriginalTexture);
    console.log('[TriplanarRenovation] Primary axis:', primaryAxis);
    
    // Calculate height bounds for the surface type
    // For floors: only apply to surfaces near the MINIMUM Y of the mesh, not all upward-facing surfaces
    let minHeight = -100;
    let maxHeight = 100;
    
    if (segment.type === 'floor') {
      // IMPORTANT: The segment bounds may include furniture/tabletops that face upward.
      // For floors, we only want to texture the LOWEST surfaces, not everything facing up.
      // Use the segment's minimum Y and add a small threshold (e.g., 0.5-1.0 mesh units above min)
      if (segment.bounds) {
        const floorMinY = segment.bounds.min.y;
        const segmentHeight = segment.bounds.max.y - segment.bounds.min.y;
        
        console.log('[TriplanarRenovation] Floor segment bounds:', 
          'Y:', floorMinY.toFixed(2), 'to', segment.bounds.max.y.toFixed(2),
          'Height span:', segmentHeight.toFixed(2));
        
        // If segment spans a large Y range (> 3 mesh units), the scan is likely tilted
        // In this case, rely on normal direction filtering only (disable height check)
        if (segmentHeight > 3.0) {
          console.log('[TriplanarRenovation] ⚠️ Large height span detected - scan may be tilted');
          console.log('[TriplanarRenovation] Disabling height filter, relying on normal direction only');
          minHeight = -1000;
          maxHeight = 1000;
        } else {
          // Normal case: floor is roughly horizontal, use height filtering
          const floorThickness = 0.8; // mesh units above minimum Y to consider as floor
          minHeight = floorMinY - 0.3;
          maxHeight = floorMinY + floorThickness;
          console.log('[TriplanarRenovation] Floor height range (restricted to bottom):', 
            minHeight.toFixed(2), 'to', maxHeight.toFixed(2));
        }
      } else {
        console.log('[TriplanarRenovation] ⚠️ No bounds on floor segment - using wide range');
        // Fallback: wide range to catch floors at any height
        minHeight = -100;
        maxHeight = 100;
      }
    } else if (segment.type === 'ceiling') {
      // Get ceiling height from segment bounding box if available
      if (segment.bounds) {
        minHeight = segment.bounds.min.y - 0.5;
        maxHeight = segment.bounds.max.y + 0.5;
      } else {
        minHeight = 2.0;
        maxHeight = 100;
      }
      console.log('[TriplanarRenovation] Ceiling height range:', minHeight, 'to', maxHeight);
    }
    
    // Create shader material
    // Check if we have a floor mask from vision AI
    const hasFloorMask = floorMaskTexture !== null && floorMaskTexture !== undefined;
    
    // Calculate mesh bounding box for mask UV mapping
    const geometry = mesh.geometry as THREE.BufferGeometry;
    geometry.computeBoundingBox();
    const meshBoundsMin = geometry.boundingBox?.min || new THREE.Vector3(-10, -10, -10);
    const meshBoundsMax = geometry.boundingBox?.max || new THREE.Vector3(10, 10, 10);
    
    // Create a placeholder 1x1 texture if no mask provided
    const placeholderMaskTexture = floorMaskTexture || (() => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#FFFFFF';  // All white = all floor (no masking)
      ctx.fillRect(0, 0, 1, 1);
      return new THREE.CanvasTexture(canvas);
    })();
    
    if (hasFloorMask) {
      console.log('[TriplanarRenovation] 🎯 Using vision AI floor mask for precise texture application');
    }
    
    const shaderMaterial = new THREE.ShaderMaterial({
      uniforms: {
        renovationTexture: { value: renovationTexture },
        originalTexture: { value: originalTexture },
        floorMaskTexture: { value: placeholderMaskTexture },
        textureScale: { value: textureScale },
        blendSharpness: { value: blendSharpness },
        renovationOpacity: { value: 1.0 },
        primaryAxis: { value: primaryAxis },
        surfaceThreshold: { value: 0.5 },  // How aligned normal must be
        hasOriginalTexture: { value: hasOriginalTexture ? 1.0 : 0.0 },
        minHeight: { value: minHeight },
        maxHeight: { value: maxHeight },
        useFloorMask: { value: hasFloorMask ? 1.0 : 0.0 },
        meshBoundsMin: { value: meshBoundsMin },
        meshBoundsMax: { value: meshBoundsMax },
      },
      vertexShader: TRIPLANAR_VERTEX_SHADER,
      fragmentShader: TRIPLANAR_FRAGMENT_SHADER,
      side: THREE.DoubleSide,
    });
    
    // Store original material for restoration
    const savedMaterial = mesh.material;
    
    // Apply shader material
    mesh.material = shaderMaterial;
    
    console.log('[TriplanarRenovation] ✅ Renovation applied successfully');
    
    return {
      success: true,
      shaderMaterial,
      restore: () => {
        // Restore original material
        mesh.material = savedMaterial;
        
        // Dispose shader resources
        shaderMaterial.dispose();
        if (material.textureUrl) {
          renovationTexture.dispose();
        }
        
        console.log('[TriplanarRenovation] Restored original material');
      },
    };
  } catch (error) {
    console.error('[TriplanarRenovation] Error:', error);
    return {
      success: false,
      shaderMaterial: null,
      restore: () => {},
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// ============================================================================
// Segment-Specific Material Application
// ============================================================================

/**
 * Apply renovation to ONLY the faces belonging to a specific segment.
 * This creates a multi-material mesh where only the segment faces
 * have the renovation texture, and everything else keeps the original.
 * 
 * @param floorMaskLookup - Optional 2D boolean array from vision AI showing where floor is
 */
export async function applySegmentRenovation(
  mesh: THREE.Mesh,
  segment: SurfaceSegment,
  materialType: string,
  materialOption: string,
  worldScale: number,
  onProgress?: (stage: string, progress: number) => void,
  preGeneratedTextureUrl?: string, // Optional: Skip generation if texture already provided
  floorMaskLookup?: boolean[][] | null // Optional: Vision-based floor mask
): Promise<TriplanarRenovationResult> {
  console.log('[TriplanarRenovation] Applying segment-specific renovation...');
  console.log('[TriplanarRenovation] Segment:', segment.type, 'with', segment.faceIndices.length, 'faces');
  if (preGeneratedTextureUrl) {
    console.log('[TriplanarRenovation] Using pre-generated texture URL');
  }
  if (floorMaskLookup && floorMaskLookup.length > 0) {
    console.log('[TriplanarRenovation] 🎯 Using vision-based floor mask for precise application');
  }
  
  onProgress?.('Generating seamless texture...', 0.1);
  
  // Determine appropriate tile size based on material type
  let tileSizeMeters = { width: 1.0, height: 1.0 };
  
  if (materialType === 'flooring') {
    if (materialOption.includes('hardwood') || materialOption.includes('plank')) {
      // Hardwood planks: typical plank is ~15cm x 180cm
      tileSizeMeters = { width: 0.5, height: 0.5 };  // Tile showing multiple planks
    } else if (materialOption.includes('tile')) {
      // Tiles: typically 30cm x 30cm to 60cm x 60cm
      tileSizeMeters = { width: 0.6, height: 0.6 };
    } else {
      tileSizeMeters = { width: 1.0, height: 1.0 };
    }
  } else if (materialType === 'paint') {
    // Paint is solid - small tile is fine
    tileSizeMeters = { width: 0.25, height: 0.25 };
  } else if (materialType === 'wallpaper') {
    // Wallpaper patterns typically repeat every 50-60cm
    tileSizeMeters = { width: 0.5, height: 0.5 };
  }
  
  // Use pre-generated texture if provided, otherwise generate a new one
  let textureResult: { success: boolean; textureUrl?: string; fallbackColor?: string; error?: string };
  
  if (preGeneratedTextureUrl) {
    // Skip generation - use the pre-generated texture
    console.log('[TriplanarRenovation] Skipping generation - using pre-generated texture');
    console.log('[TriplanarRenovation] Pre-generated URL type:', 
      preGeneratedTextureUrl.startsWith('data:') ? 'Base64 data URL' : 'File URL',
      'Length:', preGeneratedTextureUrl.length);
    textureResult = {
      success: true,
      textureUrl: preGeneratedTextureUrl,
    };
  } else {
    // Generate the seamless texture
    textureResult = await generateSeamlessTileTexture(
      materialType,
      materialOption,
      tileSizeMeters
    );
  }
  
  if (!textureResult.success) {
    return {
      success: false,
      shaderMaterial: null,
      restore: () => {},
      error: textureResult.error,
    };
  }
  
  onProgress?.('Applying to 3D mesh...', 0.7);
  
  // Prepare material config - use texture URL if available, otherwise fallback color
  const materialConfig: RenovationMaterial = {
    name: materialOption,
    type: materialType as RenovationMaterial['type'],
    repeatX: tileSizeMeters.width,
    repeatY: tileSizeMeters.height,
  };
  
  if (textureResult.textureUrl) {
    materialConfig.textureUrl = textureResult.textureUrl;
    console.log('[TriplanarRenovation] Using texture URL for renovation');
  } else if (textureResult.fallbackColor) {
    materialConfig.color = textureResult.fallbackColor;
    console.log('[TriplanarRenovation] Using fallback color for renovation:', textureResult.fallbackColor);
  } else {
    // Default color if nothing else available
    materialConfig.color = '#9C7A4A';
    console.log('[TriplanarRenovation] Using default brown color');
  }
  
  // If we have a floor mask, create a mask texture for the shader
  let maskTexture: THREE.Texture | null = null;
  if (floorMaskLookup && floorMaskLookup.length > 0) {
    console.log('[TriplanarRenovation] Creating mask texture from vision AI lookup...');
    maskTexture = createMaskTexture(floorMaskLookup);
  }
  
  // Apply the triplanar renovation with optional mask
  const result = await applyTriplanarRenovation({
    mesh,
    segment,
    material: materialConfig,
    worldScale,
    floorMaskTexture: maskTexture,
  });
  
  onProgress?.('Complete!', 1.0);
  
  return result;
}

/**
 * Create a Three.js texture from the vision mask lookup table.
 */
function createMaskTexture(maskLookup: boolean[][]): THREE.Texture {
  const resolution = maskLookup.length;
  const canvas = document.createElement('canvas');
  canvas.width = resolution;
  canvas.height = resolution;
  const ctx = canvas.getContext('2d')!;
  
  const imageData = ctx.createImageData(resolution, resolution);
  
  for (let y = 0; y < resolution; y++) {
    for (let x = 0; x < resolution; x++) {
      const idx = (y * resolution + x) * 4;
      const isFloor = maskLookup[y]?.[x] ?? false;
      const value = isFloor ? 255 : 0;
      imageData.data[idx] = value;     // R
      imageData.data[idx + 1] = value; // G
      imageData.data[idx + 2] = value; // B
      imageData.data[idx + 3] = 255;   // A
    }
  }
  
  ctx.putImageData(imageData, 0, 0);
  
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  
  console.log('[TriplanarRenovation] ✅ Mask texture created:', resolution, 'x', resolution);
  
  return texture;
}

// ============================================================================
// Prebuilt Material Library
// ============================================================================

export const RENOVATION_MATERIALS: Record<string, RenovationMaterial> = {
  // Flooring
  'oak-hardwood': {
    name: 'Oak Hardwood',
    type: 'flooring',
    repeatX: 0.5,
    repeatY: 0.5,
    roughness: 0.4,
  },
  'walnut-hardwood': {
    name: 'Walnut Hardwood',
    type: 'flooring',
    repeatX: 0.5,
    repeatY: 0.5,
    roughness: 0.3,
  },
  'white-tile': {
    name: 'White Marble Tile',
    type: 'tile',
    repeatX: 0.6,
    repeatY: 0.6,
    roughness: 0.2,
    metalness: 0.1,
  },
  'gray-tile': {
    name: 'Gray Ceramic Tile',
    type: 'tile',
    repeatX: 0.3,
    repeatY: 0.3,
    roughness: 0.5,
  },
  
  // Paint
  'white-paint': {
    name: 'Pure White',
    type: 'paint',
    color: '#FFFFFF',
    repeatX: 0.25,
    repeatY: 0.25,
    roughness: 0.9,
  },
  'gray-paint': {
    name: 'Cool Gray',
    type: 'paint',
    color: '#9CA3AF',
    repeatX: 0.25,
    repeatY: 0.25,
    roughness: 0.9,
  },
  'beige-paint': {
    name: 'Warm Beige',
    type: 'paint',
    color: '#E5D5C5',
    repeatX: 0.25,
    repeatY: 0.25,
    roughness: 0.9,
  },
};
