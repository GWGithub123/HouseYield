/**
 * AI Floor Outline Service
 * 
 * Uses GPT-4o Vision to analyze the overhead view and return polygon
 * coordinates outlining the floor area. The AI essentially "uses" an
 * outline tool to trace the floor perimeter.
 * 
 * The returned coordinates are projected onto the 3D mesh and displayed
 * as a lime green outline.
 */

import * as THREE from 'three';

export interface OutlinePoint {
  x: number;  // Normalized 0-1 screen coordinate
  y: number;  // Normalized 0-1 screen coordinate
}

export interface FloorOutlineResult {
  success: boolean;
  polygons: OutlinePoint[][];  // Multiple polygons for complex floor shapes
  confidence: number;
  description: string;
  error?: string;
}

export interface Outline3DResult {
  points: THREE.Vector3[];
  lineGeometry: THREE.BufferGeometry;
  lineMaterial: THREE.LineBasicMaterial;
  line: THREE.LineLoop;
}

/**
 * Call GPT-4o Vision to outline the floor in the overhead image.
 * The AI acts as if it's using a polygon drawing tool.
 */
export async function getAIFloorOutline(
  overheadImageBase64: string,
  onProgress?: (message: string) => void
): Promise<FloorOutlineResult> {
  console.log('[AIFloorOutline] 🎯 Requesting floor outline from GPT-4o Vision...');
  onProgress?.('Sending image to AI vision model...');
  
  try {
    const response = await fetch('/api/renovation-preview/ai-floor-outline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageBase64: overheadImageBase64,
      }),
    });
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `Server returned ${response.status}`);
    }
    
    const data = await response.json();
    
    if (!data.success) {
      throw new Error(data.error || 'AI failed to generate outline');
    }
    
    console.log('[AIFloorOutline] ✅ Received outline with', data.polygons?.length || 0, 'polygon(s)');
    onProgress?.(`AI outlined ${data.polygons?.length || 0} floor region(s)`);
    
    return {
      success: true,
      polygons: data.polygons || [],
      confidence: data.confidence || 0,
      description: data.description || '',
    };
  } catch (error) {
    console.error('[AIFloorOutline] ❌ Error:', error);
    return {
      success: false,
      polygons: [],
      confidence: 0,
      description: '',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Project 2D normalized screen coordinates to 3D world positions on the mesh.
 * Uses raycasting from the camera through each point.
 * 
 * IMPROVED: Also includes a fallback using the mesh's bounding box to estimate
 * floor position when raycasting fails.
 */
export function projectOutlineToMesh(
  polygon: OutlinePoint[],
  mesh: THREE.Mesh,
  camera: THREE.Camera,
  _canvasWidth?: number,
  _canvasHeight?: number
): THREE.Vector3[] {
  const raycaster = new THREE.Raycaster();
  const points3D: THREE.Vector3[] = [];
  
  // Get mesh bounds to help estimate floor plane
  mesh.geometry.computeBoundingBox();
  const bbox = mesh.geometry.boundingBox!;
  const worldBbox = bbox.clone().applyMatrix4(mesh.matrixWorld);
  
  // Estimate floor Y as the minimum Y of the mesh
  const floorY = worldBbox.min.y;
  const sizeX = worldBbox.max.x - worldBbox.min.x;
  const sizeZ = worldBbox.max.z - worldBbox.min.z;
  
  console.log('[AIFloorOutline] Mesh bounds:', {
    x: [worldBbox.min.x.toFixed(2), worldBbox.max.x.toFixed(2)],
    y: [worldBbox.min.y.toFixed(2), worldBbox.max.y.toFixed(2)],
    z: [worldBbox.min.z.toFixed(2), worldBbox.max.z.toFixed(2)],
  });
  console.log('[AIFloorOutline] Estimated floor Y:', floorY.toFixed(2));
  
  let raycastHits = 0;
  let fallbackHits = 0;
  
  for (const point of polygon) {
    // Convert normalized coords to NDC (-1 to 1)
    const ndc = new THREE.Vector2(
      point.x * 2 - 1,
      -(point.y * 2 - 1)  // Flip Y: 0 at top -> 1, 1 at bottom -> -1
    );
    
    // Try raycasting first
    raycaster.setFromCamera(ndc, camera);
    const intersects = raycaster.intersectObject(mesh, true);
    
    if (intersects.length > 0) {
      points3D.push(intersects[0].point.clone());
      raycastHits++;
    } else {
      // Fallback: Map 2D coordinates directly to floor plane
      // Assume the image covers the mesh bounds
      // point.x=0 -> worldBbox.min.x, point.x=1 -> worldBbox.max.x
      // point.y=0 -> worldBbox.max.z (top of image = far), point.y=1 -> worldBbox.min.z (bottom = near)
      const worldX = worldBbox.min.x + point.x * sizeX;
      const worldZ = worldBbox.max.z - point.y * sizeZ;  // Flip Z for image coords
      
      points3D.push(new THREE.Vector3(worldX, floorY + 0.05, worldZ));
      fallbackHits++;
    }
  }
  
  console.log('[AIFloorOutline] Projection results: raycast hits:', raycastHits, ', fallback:', fallbackHits);
  
  return points3D;
}

/**
 * Alternative projection method: Map 2D coordinates directly to the floor plane
 * using the mesh's bounding box. More reliable than raycasting when camera
 * setup is problematic.
 */
export function projectOutlineToFloorPlane(
  polygon: OutlinePoint[],
  mesh: THREE.Mesh
): THREE.Vector3[] {
  mesh.geometry.computeBoundingBox();
  const bbox = mesh.geometry.boundingBox!;
  const worldBbox = bbox.clone().applyMatrix4(mesh.matrixWorld);
  
  const floorY = worldBbox.min.y + 0.05;  // Slight offset above floor
  const sizeX = worldBbox.max.x - worldBbox.min.x;
  const sizeZ = worldBbox.max.z - worldBbox.min.z;
  
  const points3D: THREE.Vector3[] = [];
  
  for (const point of polygon) {
    // Map 2D image coordinates to world XZ plane
    // Assuming overhead view: image X maps to world X, image Y maps to world Z
    const worldX = worldBbox.min.x + point.x * sizeX;
    const worldZ = worldBbox.max.z - point.y * sizeZ;  // Flip for image coords
    
    points3D.push(new THREE.Vector3(worldX, floorY, worldZ));
  }
  
  console.log('[AIFloorOutline] Direct floor projection:', points3D.length, 'points');
  
  return points3D;
}

/**
 * Create a lime green 3D line loop from the projected points.
 * This visualizes the AI's floor outline on the mesh.
 */
export function createOutlineVisualization(
  points3D: THREE.Vector3[],
  offsetY: number = 0.02  // Slight offset to prevent z-fighting
): Outline3DResult | null {
  if (points3D.length < 3) {
    console.warn('[AIFloorOutline] Not enough points for outline:', points3D.length);
    return null;
  }
  
  // Offset points slightly above the surface
  const offsetPoints = points3D.map(p => 
    new THREE.Vector3(p.x, p.y + offsetY, p.z)
  );
  
  // Create line geometry
  const lineGeometry = new THREE.BufferGeometry().setFromPoints(offsetPoints);
  
  // Lime green material with glow effect
  const lineMaterial = new THREE.LineBasicMaterial({
    color: 0x00ff00,  // Lime green
    linewidth: 3,
    transparent: true,
    opacity: 1.0,
    depthTest: true,
    depthWrite: false,
  });
  
  // Create line loop (closed polygon)
  const line = new THREE.LineLoop(lineGeometry, lineMaterial);
  line.name = 'ai-floor-outline';
  line.renderOrder = 999;  // Render on top
  
  return {
    points: offsetPoints,
    lineGeometry,
    lineMaterial,
    line,
  };
}

/**
 * Create a filled polygon visualization (semi-transparent lime green area).
 */
export function createFilledOutlineVisualization(
  points3D: THREE.Vector3[],
  offsetY: number = 0.01
): THREE.Mesh | null {
  if (points3D.length < 3) return null;
  
  // Offset points
  const offsetPoints = points3D.map(p => 
    new THREE.Vector3(p.x, p.y + offsetY, p.z)
  );
  
  // Create shape from points (project to XZ plane for triangulation)
  const shape = new THREE.Shape();
  shape.moveTo(offsetPoints[0].x, offsetPoints[0].z);
  for (let i = 1; i < offsetPoints.length; i++) {
    shape.lineTo(offsetPoints[i].x, offsetPoints[i].z);
  }
  shape.closePath();
  
  // Create geometry
  const geometry = new THREE.ShapeGeometry(shape);
  
  // Rotate to be horizontal (XZ plane)
  geometry.rotateX(-Math.PI / 2);
  
  // Position at average Y height
  const avgY = offsetPoints.reduce((sum, p) => sum + p.y, 0) / offsetPoints.length;
  geometry.translate(0, avgY, 0);
  
  // Semi-transparent lime green material
  const material = new THREE.MeshBasicMaterial({
    color: 0x00ff00,
    transparent: true,
    opacity: 0.2,
    side: THREE.DoubleSide,
    depthTest: true,
    depthWrite: false,
  });
  
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'ai-floor-fill';
  mesh.renderOrder = 998;
  
  return mesh;
}

/**
 * Build a mask lookup from the AI outline polygons.
 * This can be used with the existing face-based renovation system.
 */
export function buildMaskFromOutline(
  polygons: OutlinePoint[][],
  resolution: number = 200
): boolean[][] {
  const mask: boolean[][] = [];
  
  // Initialize with false
  for (let y = 0; y < resolution; y++) {
    mask.push(new Array(resolution).fill(false));
  }
  
  // Fill in the polygons using point-in-polygon test
  for (let y = 0; y < resolution; y++) {
    for (let x = 0; x < resolution; x++) {
      const px = (x + 0.5) / resolution;
      const py = (y + 0.5) / resolution;
      
      for (const polygon of polygons) {
        if (pointInPolygon(px, py, polygon)) {
          mask[y][x] = true;
          break;
        }
      }
    }
  }
  
  return mask;
}

/**
 * Point-in-polygon test using ray casting algorithm.
 */
function pointInPolygon(x: number, y: number, polygon: OutlinePoint[]): boolean {
  if (polygon.length < 3) return false;
  
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  
  return inside;
}

/**
 * Animate the outline to make it more visible (pulsing effect).
 */
export function createOutlineAnimation(
  lineMaterial: THREE.LineBasicMaterial
): () => void {
  let animationId: number;
  let startTime = Date.now();
  
  const animate = () => {
    const elapsed = (Date.now() - startTime) / 1000;
    const pulse = 0.5 + 0.5 * Math.sin(elapsed * 3);  // Pulse between 0.5 and 1.0
    
    lineMaterial.opacity = 0.5 + pulse * 0.5;
    
    animationId = requestAnimationFrame(animate);
  };
  
  animate();
  
  // Return cleanup function
  return () => {
    cancelAnimationFrame(animationId);
  };
}
