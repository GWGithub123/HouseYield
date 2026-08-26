/**
 * Mesh Calibration Service
 * Auto-calibrates 3D photogrammetry meshes using AI-detected reference objects
 * with known standard dimensions or branded product specifications.
 * 
 * Priority hierarchy:
 * 1. Branded products (Google Search for exact specs)
 * 2. Electrical outlets/switches (NEMA standard: 4.5" × 2.75")
 * 3. Room-specific fixtures (bathtub, toilet, oven, etc.)
 * 4. Doors and architectural elements
 * 5. Flooring/baseboards
 * 6. Manual calibration fallback
 */

import * as THREE from 'three';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';

// ============================================================================
// Types
// ============================================================================

export interface CalibrationResult {
  success: boolean;
  scaleFactor: number;           // mesh units → inches
  confidence: number;            // 0-1
  referenceObject: CalibrationObject | null;
  allDetectedObjects: CalibrationObject[];
  calibratedAt: Date;
  method: 'branded_product' | 'standard_fixture' | 'manual' | 'failed';
  needsManualCalibration: boolean;
  message: string;
}

export interface CalibrationObject {
  id: string;
  type: CalibrationObjectType;
  name: string;                  // e.g., "GE Profile Dishwasher" or "Outlet Cover"
  exactDimensionInches: number;
  dimensionType: 'height' | 'width' | 'depth' | 'length' | 'diameter';
  bboxPixels: { top: number; left: number; bottom: number; right: number };
  meshPoints?: { point1: THREE.Vector3; point2: THREE.Vector3 };
  meshDistance?: number;
  confidence: number;
  source: 'nema_standard' | 'building_code' | 'product_spec' | 'common_size';
  productUrl?: string;           // For branded products
  specSource?: string;           // Where we found the spec
}

export type CalibrationObjectType = 
  // Tier 0: Branded products (highest accuracy)
  | 'branded_appliance'
  | 'branded_electronics'
  | 'branded_furniture'
  | 'branded_other'
  // Tier 1: Electrical (NEMA standard)
  | 'outlet_cover'
  | 'switch_plate'
  | 'decora_plate'
  // Tier 2: Bathroom fixtures
  | 'bathtub'
  | 'toilet'
  | 'bathroom_vanity'
  | 'bathroom_sink'
  // Tier 3: Kitchen fixtures
  | 'kitchen_counter'
  | 'dishwasher'
  | 'oven'
  | 'refrigerator'
  | 'kitchen_sink'
  // Tier 4: Doors/Architecture
  | 'interior_door'
  | 'door_handle'
  | 'door_frame'
  | 'window'
  // Tier 5: Flooring/Trim
  | 'floor_tile'
  | 'baseboard'
  | 'ceiling_height';

export interface BrandedProductDetection {
  productName: string;
  brand: string;
  model?: string;
  category: string;
  confidence: number;
  bboxPixels: { top: number; left: number; bottom: number; right: number };
  searchQuery: string;          // Query to find specs
}

export interface ProductSpecification {
  productName: string;
  dimensions: {
    height?: number;
    width?: number;
    depth?: number;
    unit: 'inches' | 'cm' | 'mm';
  };
  source: string;
  url: string;
  confidence: number;
}

// ============================================================================
// Standard Dimensions Reference
// ============================================================================

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _STANDARD_DIMENSIONS: Record<string, { 
  dimension: number; 
  dimensionType: 'height' | 'width' | 'depth' | 'length';
  source: string;
  tolerance: number;  // percentage
}> = {
  // Electrical - NEMA standard (highest reliability)
  outlet_cover: { dimension: 4.5, dimensionType: 'height', source: 'nema_standard', tolerance: 0.01 },
  switch_plate: { dimension: 4.5, dimensionType: 'height', source: 'nema_standard', tolerance: 0.01 },
  decora_plate: { dimension: 4.5, dimensionType: 'height', source: 'nema_standard', tolerance: 0.01 },
  
  // Bathroom fixtures
  bathtub: { dimension: 60, dimensionType: 'length', source: 'building_code', tolerance: 0.02 },
  toilet: { dimension: 14.5, dimensionType: 'width', source: 'common_size', tolerance: 0.05 },
  toilet_height: { dimension: 15, dimensionType: 'height', source: 'building_code', tolerance: 0.03 },
  
  // Kitchen
  kitchen_counter: { dimension: 36, dimensionType: 'height', source: 'building_code', tolerance: 0.02 },
  dishwasher: { dimension: 24, dimensionType: 'width', source: 'common_size', tolerance: 0.02 },
  oven: { dimension: 30, dimensionType: 'width', source: 'common_size', tolerance: 0.03 },
  
  // Doors
  interior_door: { dimension: 80, dimensionType: 'height', source: 'building_code', tolerance: 0.02 },
  door_handle: { dimension: 36, dimensionType: 'height', source: 'building_code', tolerance: 0.03 },
  door_frame: { dimension: 4.5, dimensionType: 'width', source: 'building_code', tolerance: 0.05 },
  
  // Flooring
  floor_tile_12: { dimension: 12, dimensionType: 'width', source: 'common_size', tolerance: 0.02 },
  floor_tile_18: { dimension: 18, dimensionType: 'width', source: 'common_size', tolerance: 0.02 },
  baseboard: { dimension: 3.5, dimensionType: 'height', source: 'common_size', tolerance: 0.05 },
  
  // Ceiling
  ceiling_height_8: { dimension: 96, dimensionType: 'height', source: 'common_size', tolerance: 0.03 },
  ceiling_height_9: { dimension: 108, dimensionType: 'height', source: 'common_size', tolerance: 0.03 },
};

// ============================================================================
// Main Calibration Function
// ============================================================================

/**
 * Auto-calibrate a mesh using AI detection and Google Search
 */
export async function autoCalibrateMesh(
  sceneImage: string,  // Base64 image of the 3D scene
  meshGroup: THREE.Group,
  camera: THREE.Camera,
  renderer: THREE.WebGLRenderer
): Promise<CalibrationResult> {
  console.log('[Calibration] Starting auto-calibration...');
  
  try {
    // Step 1: Detect all calibration objects (including branded products)
    const detectedObjects = await detectCalibrationObjects(sceneImage);
    console.log('[Calibration] Detected', detectedObjects.length, 'potential calibration objects');
    
    if (detectedObjects.length === 0) {
      return {
        success: false,
        scaleFactor: 1,
        confidence: 0,
        referenceObject: null,
        allDetectedObjects: [],
        calibratedAt: new Date(),
        method: 'failed',
        needsManualCalibration: true,
        message: 'No calibration objects detected. Please calibrate manually.',
      };
    }
    
    // Step 2: For branded products, search for exact specs
    const objectsWithSpecs = await enrichWithProductSpecs(detectedObjects);
    
    // Step 3: Sort by priority (branded first, then by confidence)
    const sortedObjects = sortByCalibrationPriority(objectsWithSpecs);
    
    // Step 4: Raycast to get 3D mesh points for each object
    const objectsWithMeshPoints = await mapToMeshCoordinates(
      sortedObjects,
      meshGroup,
      camera,
      renderer
    );
    
    // Step 5: Calculate scale factor using best object
    const bestObject = objectsWithMeshPoints.find(o => o.meshDistance && o.meshDistance > 0);
    
    if (!bestObject || !bestObject.meshDistance) {
      return {
        success: false,
        scaleFactor: 1,
        confidence: 0,
        referenceObject: null,
        allDetectedObjects: objectsWithMeshPoints,
        calibratedAt: new Date(),
        method: 'failed',
        needsManualCalibration: true,
        message: 'Could not map detected objects to 3D mesh. Please calibrate manually.',
      };
    }
    
    const scaleFactor = bestObject.exactDimensionInches / bestObject.meshDistance;
    
    // Step 6: Cross-validate with other detected objects
    const validation = crossValidateCalibration(objectsWithMeshPoints, scaleFactor);
    
    const method = bestObject.type.startsWith('branded_') ? 'branded_product' : 'standard_fixture';
    
    console.log('[Calibration] Success!', {
      scaleFactor,
      referenceObject: bestObject.name,
      confidence: validation.confidence,
    });
    
    return {
      success: true,
      scaleFactor,
      confidence: validation.confidence,
      referenceObject: bestObject,
      allDetectedObjects: objectsWithMeshPoints,
      calibratedAt: new Date(),
      method,
      needsManualCalibration: false,
      message: `Calibrated using ${bestObject.name} (${validation.confidence * 100}% confidence)`,
    };
    
  } catch (error) {
    console.error('[Calibration] Error:', error);
    return {
      success: false,
      scaleFactor: 1,
      confidence: 0,
      referenceObject: null,
      allDetectedObjects: [],
      calibratedAt: new Date(),
      method: 'failed',
      needsManualCalibration: true,
      message: `Calibration failed: ${error}`,
    };
  }
}

// ============================================================================
// AI Detection
// ============================================================================

/**
 * Use OpenAI Vision to detect calibration objects in the scene
 */
async function detectCalibrationObjects(sceneImage: string): Promise<CalibrationObject[]> {
  const response = await fetch(`${BACKEND_URL}/api/calibration/detect-objects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: sceneImage }),
  });
  
  if (!response.ok) {
    throw new Error(`Detection API error: ${response.status}`);
  }
  
  const data = await response.json();
  return data.objects || [];
}

/**
 * Search Google for exact product specifications
 */
async function enrichWithProductSpecs(
  objects: CalibrationObject[]
): Promise<CalibrationObject[]> {
  const enrichedObjects: CalibrationObject[] = [];
  
  for (const obj of objects) {
    if (obj.type.startsWith('branded_') && obj.name) {
      try {
        // Search for product specifications
        const specs = await searchProductSpecs(obj.name);
        
        if (specs) {
          // Update object with exact dimensions from specs
          enrichedObjects.push({
            ...obj,
            exactDimensionInches: convertToInches(specs.dimensions),
            source: 'product_spec',
            productUrl: specs.url,
            specSource: specs.source,
            confidence: Math.min(obj.confidence, specs.confidence),
          });
          
          console.log('[Calibration] Found specs for', obj.name, ':', specs.dimensions);
        } else {
          // Keep original object without specs
          enrichedObjects.push(obj);
        }
      } catch (error) {
        console.warn('[Calibration] Could not fetch specs for', obj.name, error);
        enrichedObjects.push(obj);
      }
    } else {
      // Non-branded object - use standard dimensions
      enrichedObjects.push(obj);
    }
  }
  
  return enrichedObjects;
}

/**
 * Search Google for product specifications
 */
async function searchProductSpecs(productName: string): Promise<ProductSpecification | null> {
  const searchQuery = `${productName} dimensions specifications inches`;
  
  const response = await fetch(`${BACKEND_URL}/api/calibration/product-specs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      productName,
      searchQuery,
    }),
  });
  
  if (!response.ok) {
    console.warn('[Calibration] Product spec search failed:', response.status);
    return null;
  }
  
  const data = await response.json();
  return data.specification || null;
}

// ============================================================================
// Coordinate Mapping
// ============================================================================

/**
 * Map 2D bounding boxes to 3D mesh coordinates via raycasting
 */
async function mapToMeshCoordinates(
  objects: CalibrationObject[],
  meshGroup: THREE.Group,
  camera: THREE.Camera,
  renderer: THREE.WebGLRenderer
): Promise<CalibrationObject[]> {
  const raycaster = new THREE.Raycaster();
  const canvas = renderer.domElement;
  const rect = canvas.getBoundingClientRect();
  
  return objects.map(obj => {
    const { top, left, bottom, right } = obj.bboxPixels;
    
    // Get center points of the dimension we're measuring
    let point1Pixel: { x: number; y: number };
    let point2Pixel: { x: number; y: number };
    
    if (obj.dimensionType === 'height') {
      // Measure top to bottom
      const centerX = (left + right) / 2;
      point1Pixel = { x: centerX, y: top };
      point2Pixel = { x: centerX, y: bottom };
    } else {
      // Measure left to right
      const centerY = (top + bottom) / 2;
      point1Pixel = { x: left, y: centerY };
      point2Pixel = { x: right, y: centerY };
    }
    
    // Convert to normalized device coordinates (-1 to 1)
    const ndc1 = {
      x: ((point1Pixel.x - rect.left) / rect.width) * 2 - 1,
      y: -((point1Pixel.y - rect.top) / rect.height) * 2 + 1,
    };
    const ndc2 = {
      x: ((point2Pixel.x - rect.left) / rect.width) * 2 - 1,
      y: -((point2Pixel.y - rect.top) / rect.height) * 2 + 1,
    };
    
    // Raycast to mesh
    raycaster.setFromCamera(new THREE.Vector2(ndc1.x, ndc1.y), camera);
    const hits1 = raycaster.intersectObject(meshGroup, true);
    
    raycaster.setFromCamera(new THREE.Vector2(ndc2.x, ndc2.y), camera);
    const hits2 = raycaster.intersectObject(meshGroup, true);
    
    if (hits1.length > 0 && hits2.length > 0) {
      const meshPoint1 = hits1[0].point.clone();
      const meshPoint2 = hits2[0].point.clone();
      const meshDistance = meshPoint1.distanceTo(meshPoint2);
      
      return {
        ...obj,
        meshPoints: { point1: meshPoint1, point2: meshPoint2 },
        meshDistance,
      };
    }
    
    return obj;
  });
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Cross-validate calibration using multiple detected objects
 */
function crossValidateCalibration(
  objects: CalibrationObject[],
  _proposedScaleFactor: number
): { confidence: number; agreementScore: number } {
  const objectsWithMeasurements = objects.filter(o => o.meshDistance && o.meshDistance > 0);
  
  if (objectsWithMeasurements.length < 2) {
    // Can't cross-validate with only one object
    return { confidence: 0.75, agreementScore: 1 };
  }
  
  // Calculate what scale factor each object would suggest
  const scaleFactors = objectsWithMeasurements.map(obj => 
    obj.exactDimensionInches / obj.meshDistance!
  );
  
  // Check how well they agree
  const avgScale = scaleFactors.reduce((a, b) => a + b, 0) / scaleFactors.length;
  const deviations = scaleFactors.map(s => Math.abs(s - avgScale) / avgScale);
  const maxDeviation = Math.max(...deviations);
  
  if (maxDeviation < 0.02) {
    // All objects agree within 2%
    return { confidence: 0.98, agreementScore: 1 - maxDeviation };
  } else if (maxDeviation < 0.05) {
    // Agreement within 5%
    return { confidence: 0.90, agreementScore: 1 - maxDeviation };
  } else if (maxDeviation < 0.10) {
    // Agreement within 10%
    return { confidence: 0.75, agreementScore: 1 - maxDeviation };
  } else {
    // Poor agreement - may need manual verification
    return { confidence: 0.50, agreementScore: 1 - maxDeviation };
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Sort objects by calibration priority
 */
function sortByCalibrationPriority(objects: CalibrationObject[]): CalibrationObject[] {
  const priorityOrder: Record<string, number> = {
    // Branded products first (exact specs)
    branded_appliance: 1,
    branded_electronics: 2,
    branded_furniture: 3,
    branded_other: 4,
    // Then electrical (NEMA standard)
    outlet_cover: 10,
    switch_plate: 11,
    decora_plate: 12,
    // Bathroom
    bathtub: 20,
    toilet: 21,
    // Kitchen
    dishwasher: 30,
    oven: 31,
    kitchen_counter: 32,
    // Doors
    interior_door: 40,
    door_handle: 41,
    // Flooring
    floor_tile: 50,
    baseboard: 51,
    // Ceiling (least reliable)
    ceiling_height: 60,
  };
  
  return objects.sort((a, b) => {
    const priorityA = priorityOrder[a.type] || 100;
    const priorityB = priorityOrder[b.type] || 100;
    
    if (priorityA !== priorityB) {
      return priorityA - priorityB;
    }
    
    // Same priority - sort by confidence
    return b.confidence - a.confidence;
  });
}

/**
 * Convert dimensions to inches
 */
function convertToInches(dimensions: ProductSpecification['dimensions']): number {
  // Use the first available dimension
  const value = dimensions.height || dimensions.width || dimensions.depth || 0;
  
  switch (dimensions.unit) {
    case 'inches':
      return value;
    case 'cm':
      return value / 2.54;
    case 'mm':
      return value / 25.4;
    default:
      return value;
  }
}

// ============================================================================
// Manual Calibration
// ============================================================================

/**
 * Manually calibrate using two clicked points and a known distance
 */
export function manualCalibrate(
  point1: THREE.Vector3,
  point2: THREE.Vector3,
  realDistanceInches: number
): CalibrationResult {
  const meshDistance = point1.distanceTo(point2);
  const scaleFactor = realDistanceInches / meshDistance;
  
  return {
    success: true,
    scaleFactor,
    confidence: 0.95,  // High confidence for manual
    referenceObject: {
      id: 'manual-' + Date.now(),
      type: 'branded_other',
      name: 'Manual Calibration',
      exactDimensionInches: realDistanceInches,
      dimensionType: 'length',
      bboxPixels: { top: 0, left: 0, bottom: 0, right: 0 },
      meshPoints: { point1, point2 },
      meshDistance,
      confidence: 1,
      source: 'product_spec',
    },
    allDetectedObjects: [],
    calibratedAt: new Date(),
    method: 'manual',
    needsManualCalibration: false,
    message: `Manually calibrated: ${realDistanceInches}" = ${meshDistance.toFixed(4)} mesh units`,
  };
}

// ============================================================================
// Calibrated Measurement
// ============================================================================

/**
 * Apply calibration to a measurement
 */
export function getCalibratedDistance(
  meshDistance: number,
  calibration: CalibrationResult,
  outputUnit: 'inches' | 'feet' | 'meters' = 'inches'
): { value: number; unit: string; confidence: number } {
  const distanceInches = meshDistance * calibration.scaleFactor;
  
  switch (outputUnit) {
    case 'feet':
      return {
        value: distanceInches / 12,
        unit: 'ft',
        confidence: calibration.confidence,
      };
    case 'meters':
      return {
        value: distanceInches * 0.0254,
        unit: 'm',
        confidence: calibration.confidence,
      };
    default:
      return {
        value: distanceInches,
        unit: 'in',
        confidence: calibration.confidence,
      };
  }
}

/**
 * Calculate calibrated area (e.g., for flooring)
 */
export function getCalibratedArea(
  meshArea: number,
  calibration: CalibrationResult,
  outputUnit: 'sqft' | 'sqm' = 'sqft'
): { value: number; unit: string; confidence: number } {
  // Area scales with the square of the linear scale factor
  const areaInSqInches = meshArea * Math.pow(calibration.scaleFactor, 2);
  
  switch (outputUnit) {
    case 'sqm':
      return {
        value: areaInSqInches * 0.00064516,  // sq inches to sq meters
        unit: 'sq m',
        confidence: calibration.confidence,
      };
    default:
      return {
        value: areaInSqInches / 144,  // sq inches to sq feet
        unit: 'sq ft',
        confidence: calibration.confidence,
      };
  }
}

// ============================================================================
// Scene Capture
// ============================================================================

/**
 * Capture the current 3D scene as a base64 image for AI analysis
 */
export function captureSceneImage(renderer: THREE.WebGLRenderer): string {
  return renderer.domElement.toDataURL('image/jpeg', 0.9);
}

/**
 * Capture scene from multiple angles for better detection
 */
export async function captureMultiAngleImages(
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  renderer: THREE.WebGLRenderer,
  meshCenter: THREE.Vector3
): Promise<string[]> {
  const images: string[] = [];
  const originalPosition = camera.position.clone();
  const originalRotation = camera.rotation.clone();
  
  const angles = [0, 90, 180, 270];  // 4 views around the room
  const distance = 10;  // Distance from center
  
  for (const angle of angles) {
    const radians = (angle * Math.PI) / 180;
    
    camera.position.set(
      meshCenter.x + Math.sin(radians) * distance,
      meshCenter.y + 5,  // Slightly above
      meshCenter.z + Math.cos(radians) * distance
    );
    camera.lookAt(meshCenter);
    
    renderer.render(scene, camera);
    images.push(renderer.domElement.toDataURL('image/jpeg', 0.9));
  }
  
  // Restore camera
  camera.position.copy(originalPosition);
  camera.rotation.copy(originalRotation);
  
  return images;
}
