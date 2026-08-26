/**
 * AI Interior Scan Service
 * 
 * Uses Vision AI models to analyze a 3D photogrammetry mesh from an "inside view"
 * perspective. The AI looks around the 3D room and identifies renovation opportunities,
 * placing flags/markers at suggested locations.
 * 
 * When a flag is clicked, the system captures that view and sends it to Gemini
 * (Nano Banana Pro) to generate a preview of the completed renovation.
 */

import * as THREE from 'three';

// ============================================================================
// Types
// ============================================================================

export interface RenovationSuggestion {
  id: string;
  type: RenovationSuggestionType;
  title: string;
  description: string;
  priority: 'high' | 'medium' | 'low';
  
  // 3D position for the marker in the scene
  markerPosition: THREE.Vector3;
  
  // Direction the AI was looking when it spotted this
  viewDirection: THREE.Vector3;
  
  // Camera position that provides best view of this suggestion
  cameraPosition: THREE.Vector3;
  cameraTarget: THREE.Vector3;
  
  // Bounding info for the renovation area
  boundingBox?: {
    min: THREE.Vector3;
    max: THREE.Vector3;
  };
  
  // Suggested renovation details
  suggestedRenovation: {
    renovationType: string;
    renovationOption: string;
    estimatedCost?: { low: number; high: number };
    roiEstimate?: number;
  };
  
  // Captured image from the AI's perspective
  capturedImageBase64?: string;
  
  // Generated preview image after renovation
  previewImageBase64?: string;
  previewGenerating?: boolean;
  previewError?: string;
}

export type RenovationSuggestionType = 
  | 'flooring'
  | 'walls'
  | 'ceiling'
  | 'bathroom_vanity'
  | 'kitchen_cabinets'
  | 'countertops'
  | 'lighting'
  | 'windows'
  | 'doors'
  | 'appliances'
  | 'trim'
  | 'other';

export interface InteriorScanResult {
  success: boolean;
  suggestions: RenovationSuggestion[];
  scannedViewpoints: number;
  processingTimeMs: number;
  error?: string;
}

export interface InteriorViewpoint {
  name: string;
  position: THREE.Vector3;
  target: THREE.Vector3;
  up: THREE.Vector3;
  fov: number;
}

export interface RenovationPreviewRequest {
  suggestionId: string;
  capturedImageBase64: string;
  renovationType: string;
  renovationOption: string;
  customPrompt?: string;
  roomDimensions?: {
    width: number;
    length: number;
    height: number;
    unit: 'ft' | 'm';
  };
}

export interface RenovationPreviewResult {
  success: boolean;
  previewImageBase64?: string;
  description?: string;
  error?: string;
}

// ============================================================================
// Constants
// ============================================================================

const RENDER_WIDTH = 1024;
const RENDER_HEIGHT = 1024;

const SUGGESTION_TYPE_LABELS: Record<RenovationSuggestionType, { label: string; icon: string; color: string }> = {
  flooring: { label: 'Flooring', icon: '🪵', color: '#8B4513' },
  walls: { label: 'Walls', icon: '🎨', color: '#6366F1' },
  ceiling: { label: 'Ceiling', icon: '⬆️', color: '#F59E0B' },
  bathroom_vanity: { label: 'Bathroom Vanity', icon: '🚿', color: '#06B6D4' },
  kitchen_cabinets: { label: 'Kitchen Cabinets', icon: '🍳', color: '#10B981' },
  countertops: { label: 'Countertops', icon: '🧱', color: '#6D28D9' },
  lighting: { label: 'Lighting', icon: '💡', color: '#FBBF24' },
  windows: { label: 'Windows', icon: '🪟', color: '#3B82F6' },
  doors: { label: 'Doors', icon: '🚪', color: '#78350F' },
  appliances: { label: 'Appliances', icon: '🍽️', color: '#64748B' },
  trim: { label: 'Trim/Molding', icon: '📐', color: '#EC4899' },
  other: { label: 'Other', icon: '🔧', color: '#9CA3AF' },
};

// Renovation options for each type
const RENOVATION_OPTIONS: Record<RenovationSuggestionType, string[]> = {
  flooring: ['hardwood', 'walnut', 'oak', 'tile', 'marble', 'vinyl', 'carpet', 'laminate'],
  walls: ['white paint', 'gray paint', 'beige paint', 'accent wall', 'wallpaper', 'wainscoting'],
  ceiling: ['white paint', 'crown molding', 'tray ceiling', 'coffered ceiling'],
  bathroom_vanity: ['modern floating vanity', 'double sink vanity', 'marble countertop vanity'],
  kitchen_cabinets: ['white shaker cabinets', 'gray cabinets', 'wood tone cabinets', 'two-tone cabinets'],
  countertops: ['granite', 'quartz', 'marble', 'butcher block', 'concrete'],
  lighting: ['recessed lighting', 'pendant lights', 'chandelier', 'track lighting'],
  windows: ['larger windows', 'energy efficient windows', 'bay window'],
  doors: ['modern door', 'barn door', 'french doors', 'glass door'],
  appliances: ['stainless steel appliances', 'smart appliances', 'professional range'],
  trim: ['white trim', 'crown molding', 'chair rail', 'baseboards'],
  other: ['custom renovation'],
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get label and styling info for a suggestion type
 */
export function getSuggestionTypeInfo(type: RenovationSuggestionType) {
  return SUGGESTION_TYPE_LABELS[type] || SUGGESTION_TYPE_LABELS.other;
}

/**
 * Get renovation options for a suggestion type
 */
export function getRenovationOptionsForType(type: RenovationSuggestionType): string[] {
  return RENOVATION_OPTIONS[type] || RENOVATION_OPTIONS.other;
}

/**
 * Generate unique ID for a suggestion
 */
function generateSuggestionId(): string {
  return `suggestion_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// ============================================================================
// Interior Viewpoint Generation
// ============================================================================

/**
 * Generate viewpoints for scanning the interior of a 3D room mesh.
 * Creates camera positions inside the room looking around at walls, floor, ceiling.
 */
export function generateInteriorViewpoints(
  mesh: THREE.Mesh | THREE.Group,
  numViewpoints: number = 16
): InteriorViewpoint[] {
  console.log('[AIInteriorScan] Generating interior viewpoints for room scan...');
  
  // Ensure world matrix is updated
  mesh.updateMatrixWorld(true);
  
  // Get world-space bounding box
  const worldBbox = new THREE.Box3().setFromObject(mesh);
  const center = new THREE.Vector3();
  worldBbox.getCenter(center);
  const size = new THREE.Vector3();
  worldBbox.getSize(size);
  
  console.log(`[AIInteriorScan] Room bounds: ${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)}`);
  console.log(`[AIInteriorScan] Room center: (${center.x.toFixed(2)}, ${center.y.toFixed(2)}, ${center.z.toFixed(2)})`);
  
  const floorY = worldBbox.min.y;
  const ceilingY = worldBbox.max.y;
  const roomHeight = ceilingY - floorY;
  
  // Eye height: ~1.6m or 50% of room height
  const eyeHeight = Math.min(1.6, roomHeight * 0.5);
  const cameraY = floorY + eyeHeight;
  
  const viewpoints: InteriorViewpoint[] = [];
  
  // Calculate look distances for wall viewing
  const lookDistanceX = size.x * 0.45;
  const lookDistanceZ = size.z * 0.45;
  
  // 1. Add a floor-down view
  viewpoints.push({
    name: 'floor-view',
    position: new THREE.Vector3(center.x, ceilingY + 1, center.z),
    target: new THREE.Vector3(center.x, floorY, center.z),
    up: new THREE.Vector3(0, 0, -1),
    fov: 90,
  });
  
  // 2. Add a ceiling-up view
  viewpoints.push({
    name: 'ceiling-view',
    position: new THREE.Vector3(center.x, floorY + 0.5, center.z),
    target: new THREE.Vector3(center.x, ceilingY, center.z),
    up: new THREE.Vector3(0, 0, 1),
    fov: 90,
  });
  
  // 3. Generate horizontal views around the room at eye height
  const horizontalViews = numViewpoints - 2;
  for (let i = 0; i < horizontalViews; i++) {
    const angle = (i / horizontalViews) * Math.PI * 2;
    
    // Camera at center of room at eye height
    const camPos = new THREE.Vector3(center.x, cameraY, center.z);
    
    // Look outward toward walls
    const lookX = center.x + Math.cos(angle) * lookDistanceX;
    const lookZ = center.z + Math.sin(angle) * lookDistanceZ;
    
    // Look at eye height (middle of walls)
    const lookY = cameraY;
    
    const targetPos = new THREE.Vector3(lookX, lookY, lookZ);
    
    viewpoints.push({
      name: `interior-${i}`,
      position: camPos.clone(),
      target: targetPos,
      up: new THREE.Vector3(0, 1, 0),
      fov: 75,
    });
  }
  
  console.log(`[AIInteriorScan] Generated ${viewpoints.length} interior viewpoints`);
  return viewpoints;
}

// ============================================================================
// Render Interior Views
// ============================================================================

/**
 * Render the mesh from a specific viewpoint and return the image as base64
 */
export function renderViewpoint(
  mesh: THREE.Mesh | THREE.Group,
  scene: THREE.Scene,
  viewpoint: InteriorViewpoint,
  width: number = RENDER_WIDTH,
  height: number = RENDER_HEIGHT
): string {
  // Create offscreen canvas
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  
  // Create renderer
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    preserveDrawingBuffer: true,
    alpha: false,
  });
  renderer.setSize(width, height);
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  
  // Create camera
  const camera = new THREE.PerspectiveCamera(viewpoint.fov, width / height, 0.01, 1000);
  camera.position.copy(viewpoint.position);
  camera.up.copy(viewpoint.up);
  camera.lookAt(viewpoint.target);
  camera.updateProjectionMatrix();
  
  // Ensure mesh materials are double-sided for interior views
  mesh.traverse((child) => {
    if (child instanceof THREE.Mesh && child.material) {
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const mat of materials) {
        if ('side' in mat) {
          (mat as THREE.Material).side = THREE.DoubleSide;
        }
      }
    }
  });
  
  // Add lighting for good visibility
  const existingLights = scene.children.filter(c => c instanceof THREE.Light);
  const tempLights: THREE.Light[] = [];
  
  if (existingLights.length === 0) {
    const ambient = new THREE.AmbientLight(0xffffff, 1.0);
    const directional = new THREE.DirectionalLight(0xffffff, 0.8);
    directional.position.set(5, 10, 5);
    scene.add(ambient);
    scene.add(directional);
    tempLights.push(ambient, directional);
  }
  
  // Render
  renderer.render(scene, camera);
  
  // Get image data
  const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
  
  // Cleanup
  renderer.dispose();
  tempLights.forEach(light => scene.remove(light));
  
  return dataUrl;
}

/**
 * Render all interior viewpoints and return images
 */
export function renderAllInteriorViews(
  mesh: THREE.Mesh | THREE.Group,
  scene: THREE.Scene,
  viewpoints: InteriorViewpoint[]
): Array<{ viewpoint: InteriorViewpoint; imageBase64: string }> {
  console.log(`[AIInteriorScan] Rendering ${viewpoints.length} interior views...`);
  
  const renderedViews: Array<{ viewpoint: InteriorViewpoint; imageBase64: string }> = [];
  
  for (const viewpoint of viewpoints) {
    const imageBase64 = renderViewpoint(mesh, scene, viewpoint);
    renderedViews.push({ viewpoint, imageBase64 });
  }
  
  console.log(`[AIInteriorScan] Rendered ${renderedViews.length} views`);
  return renderedViews;
}

// ============================================================================
// AI Vision Analysis
// ============================================================================

/**
 * Get API URL helper
 */
function getApiUrl(path: string): string {
  const baseEnv = (import.meta as any).env?.VITE_PUSH_SERVER_URL;
  const useProxy = import.meta.env.MODE === 'development' && !baseEnv;
  return useProxy ? path : `${baseEnv || 'http://127.0.0.1:3001'}${path}`;
}

/**
 * Raycast from camera to target and find intersection with mesh.
 * This ensures markers are placed ON the mesh surface, not floating in space.
 */
function raycastToMeshSurface(
  mesh: THREE.Mesh | THREE.Group,
  origin: THREE.Vector3,
  direction: THREE.Vector3
): THREE.Vector3 | null {
  // Force update all world matrices before raycasting
  mesh.updateMatrixWorld(true);
  
  // Debug: Check mesh structure
  let totalGeometries = 0;
  mesh.traverse((child) => {
    if (child instanceof THREE.Mesh && child.geometry) {
      totalGeometries++;
    }
  });
  console.log(`[AIInteriorScan] Mesh contains ${totalGeometries} geometries`);
  
  const raycaster = new THREE.Raycaster();
  const normalizedDir = direction.clone().normalize();
  
  // Try forward raycast first (camera to target)
  raycaster.set(origin, normalizedDir);
  let intersects = raycaster.intersectObject(mesh, true);
  
  // If no hits, try REVERSE raycast (target back to camera)
  // This handles inside-out meshes where normals face outward
  if (intersects.length === 0) {
    const targetPoint = origin.clone().add(normalizedDir.multiplyScalar(50)); // 50 units ahead
    const reverseDir = origin.clone().sub(targetPoint).normalize();
    raycaster.set(targetPoint, reverseDir);
    intersects = raycaster.intersectObject(mesh, true);
    console.log(`[AIInteriorScan] Reverse raycast from outside found ${intersects.length} hits`);
  }
  
  console.log(`[AIInteriorScan] Raycast from (${origin.x.toFixed(2)}, ${origin.y.toFixed(2)}, ${origin.z.toFixed(2)}) found ${intersects.length} intersections`);
  
  if (intersects.length > 0) {
    // Return closest intersection point
    const point = intersects[0].point.clone();
    console.log(`[AIInteriorScan] ✓ Hit at distance ${intersects[0].distance.toFixed(2)}, position: (${point.x.toFixed(2)}, ${point.y.toFixed(2)}, ${point.z.toFixed(2)})`);
    return point;
  }
  
  return null;
}

/**
 * Send rendered views to AI for renovation suggestion analysis.
 * The AI looks at each view and identifies areas that need renovation.
 */
export async function analyzeInteriorViews(
  renderedViews: Array<{ viewpoint: InteriorViewpoint; imageBase64: string }>,
  mesh: THREE.Mesh | THREE.Group,
  roomDimensions?: { width: number; length: number; height: number; unit: 'ft' | 'm' },
  _onProgress?: (current: number, total: number) => void
): Promise<InteriorScanResult> {
  console.log('[AIInteriorScan] Analyzing interior views for renovation suggestions...');
  const startTime = Date.now();
  
  try {
    const response = await fetch(getApiUrl('/api/renovation/analyze-interior-views'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        views: renderedViews.map(v => ({
          viewName: v.viewpoint.name,
          imageBase64: v.imageBase64,
          cameraPosition: {
            x: v.viewpoint.position.x,
            y: v.viewpoint.position.y,
            z: v.viewpoint.position.z,
          },
          cameraTarget: {
            x: v.viewpoint.target.x,
            y: v.viewpoint.target.y,
            z: v.viewpoint.target.z,
          },
        })),
        roomDimensions,
      }),
    });
    
    const data = await response.json();
    
    if (!response.ok || !data.success) {
      throw new Error(data.error || 'Failed to analyze interior views');
    }
    
    // Convert response suggestions to our type with THREE vectors
    // AND raycast to find actual mesh surface positions
    const suggestions: RenovationSuggestion[] = (data.suggestions || []).map((s: any) => {
      const cameraPos = new THREE.Vector3(s.cameraPosition.x, s.cameraPosition.y, s.cameraPosition.z);
      const cameraTarget = new THREE.Vector3(s.cameraTarget.x, s.cameraTarget.y, s.cameraTarget.z);
      const direction = new THREE.Vector3().subVectors(cameraTarget, cameraPos);
      
      // Raycast to find actual surface point
      let markerPosition = raycastToMeshSurface(mesh, cameraPos, direction);
      
      // If raycast fails, place marker between camera and target
      if (!markerPosition) {
        console.warn(`[AIInteriorScan] ⚠️ Raycast failed for "${s.title}", placing at 60% from camera to target`);
        // Place marker 60% of the way from camera to target
        markerPosition = cameraPos.clone().lerp(cameraTarget, 0.6);
        console.log(`[AIInteriorScan] Fallback position: (${markerPosition.x.toFixed(2)}, ${markerPosition.y.toFixed(2)}, ${markerPosition.z.toFixed(2)})`);
      } else {
        // Offset the marker INWARD (toward camera) from the surface
        // This ensures markers appear on the inside of the room
        const toCamera = cameraPos.clone().sub(markerPosition).normalize();
        markerPosition.add(toCamera.multiplyScalar(0.2)); // Move 0.2 units toward camera (inside)
        console.log(`[AIInteriorScan] ✓ Marker for "${s.title}" at (${markerPosition.x.toFixed(2)}, ${markerPosition.y.toFixed(2)}, ${markerPosition.z.toFixed(2)}) [offset inward]`);
      }
      
      return {
        id: s.id || generateSuggestionId(),
        type: s.type as RenovationSuggestionType,
        title: s.title,
        description: s.description,
        priority: s.priority || 'medium',
        markerPosition,
        viewDirection: direction.normalize(),
        cameraPosition: cameraPos,
        cameraTarget: cameraTarget,
        suggestedRenovation: {
          renovationType: s.suggestedRenovation?.renovationType || s.type,
          renovationOption: s.suggestedRenovation?.renovationOption || 'modern update',
          estimatedCost: s.suggestedRenovation?.estimatedCost,
          roiEstimate: s.suggestedRenovation?.roiEstimate,
        },
        capturedImageBase64: s.capturedImageBase64,
      };
    });
    
    return {
      success: true,
      suggestions,
      scannedViewpoints: renderedViews.length,
      processingTimeMs: Date.now() - startTime,
    };
  } catch (error: any) {
    console.error('[AIInteriorScan] Analysis error:', error);
    return {
      success: false,
      suggestions: [],
      scannedViewpoints: renderedViews.length,
      processingTimeMs: Date.now() - startTime,
      error: error.message,
    };
  }
}

// ============================================================================
// Renovation Preview Generation
// ============================================================================

/**
 * Generate a renovation preview using Gemini (Nano Banana Pro).
 * Takes the captured view image and generates a preview with the renovation applied.
 */
export async function generateRenovationPreview(
  request: RenovationPreviewRequest
): Promise<RenovationPreviewResult> {
  console.log('[AIInteriorScan] Generating renovation preview...');
  console.log(`[AIInteriorScan] Type: ${request.renovationType}, Option: ${request.renovationOption}`);
  
  try {
    // Build the prompt using the conversational style that works well with Gemini
    let prompt = request.customPrompt;
    
    if (!prompt) {
      // Use the proven prompt format from the user's example
      prompt = `Can you give this room a ${request.renovationOption} ${request.renovationType}`;
      
      if (request.roomDimensions && (request.renovationType === 'flooring' || request.renovationType === 'walls')) {
        const { width, length, unit } = request.roomDimensions;
        const itemType = request.renovationType === 'flooring' 
          ? (request.renovationOption.includes('tile') || request.renovationOption.includes('marble') ? 'tiles' : 'wood panels')
          : 'panels';
        prompt += ` but make sure that you use the exact room dimensions shown (${width.toFixed(1)} x ${length.toFixed(1)} ${unit}) to have a real world accurate number of ${itemType} necessary for this room`;
      }
      
      prompt += `. Also don't change the look of anything else in the room besides adding this ${request.renovationOption} ${request.renovationType}, I want to see how the room will look with this renovation applied.`;
    }
    
    // Call the renovation preview endpoint
    const response = await fetch(getApiUrl('/api/renovation-preview/generate'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageData: request.capturedImageBase64,
        renovationType: request.renovationType,
        renovationOption: request.renovationOption,
        customPrompt: prompt,
      }),
    });
    
    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(data.error || 'Failed to generate renovation preview');
    }
    
    if (data.success && (data.imageUrl || data.generatedImageUrl)) {
      return {
        success: true,
        previewImageBase64: data.imageUrl || data.generatedImageUrl,
        description: data.description,
      };
    }
    
    // If no image was generated, return the description
    return {
      success: true,
      description: data.description || 'Preview generated - see description',
    };
  } catch (error: any) {
    console.error('[AIInteriorScan] Preview generation error:', error);
    return {
      success: false,
      error: error.message,
    };
  }
}

// ============================================================================
// Full Interior Scan Workflow
// ============================================================================

/**
 * Perform a complete AI interior scan of a 3D room mesh.
 * 1. Generate viewpoints inside the room
 * 2. Render views from each position
 * 3. Send to AI for renovation analysis
 * 4. Return suggestions with marker positions
 */
export async function performInteriorScan(
  mesh: THREE.Mesh | THREE.Group,
  scene: THREE.Scene,
  options?: {
    numViewpoints?: number;
    roomDimensions?: { width: number; length: number; height: number; unit: 'ft' | 'm' };
    onProgress?: (stage: string, progress: number) => void;
  }
): Promise<InteriorScanResult> {
  console.log('[AIInteriorScan] Starting full interior scan...');
  const startTime = Date.now();
  
  const { numViewpoints = 12, roomDimensions, onProgress } = options || {};
  
  try {
    // Stage 1: Generate viewpoints
    onProgress?.('Generating viewpoints', 0.1);
    const viewpoints = generateInteriorViewpoints(mesh, numViewpoints);
    
    // Stage 2: Render all views
    onProgress?.('Rendering interior views', 0.3);
    const renderedViews = renderAllInteriorViews(mesh, scene, viewpoints);
    
    // Stage 3: Analyze with AI (pass mesh for raycasting)
    onProgress?.('AI analyzing views', 0.5);
    const result = await analyzeInteriorViews(
      renderedViews,
      mesh,  // Pass mesh for raycasting marker positions
      roomDimensions,
      (current, total) => {
        const progress = 0.5 + (current / total) * 0.4;
        onProgress?.('AI analyzing views', progress);
      }
    );
    
    onProgress?.('Complete', 1.0);
    
    return {
      ...result,
      processingTimeMs: Date.now() - startTime,
    };
  } catch (error: any) {
    console.error('[AIInteriorScan] Full scan error:', error);
    return {
      success: false,
      suggestions: [],
      scannedViewpoints: 0,
      processingTimeMs: Date.now() - startTime,
      error: error.message,
    };
  }
}

// ============================================================================
// Utility: Capture Specific View for Suggestion
// ============================================================================

/**
 * Capture a specific view for a renovation suggestion.
 * Used when user clicks a marker and wants to generate a preview.
 */
export function captureSuggestionView(
  mesh: THREE.Mesh | THREE.Group,
  scene: THREE.Scene,
  suggestion: RenovationSuggestion
): string {
  const viewpoint: InteriorViewpoint = {
    name: `suggestion-${suggestion.id}`,
    position: suggestion.cameraPosition.clone(),
    target: suggestion.cameraTarget.clone(),
    up: new THREE.Vector3(0, 1, 0),
    fov: 75,
  };
  
  return renderViewpoint(mesh, scene, viewpoint);
}
