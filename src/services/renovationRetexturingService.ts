/**
 * Renovation Retexturing Service
 * 
 * Uses a multi-view approach to apply AI renovations to 3D models:
 * 
 * PIPELINE:
 * 1. Render the mesh from multiple viewpoints (matching original camera poses)
 * 2. Send each rendered view to Gemini for renovation editing
 * 3. Upload edited images + camera data to GCP
 * 4. Run OpenMVS TextureMesh to create new texture atlas from edited images
 * 5. Download and apply the re-textured mesh
 * 
 * This approach combines Gemini's excellent 2D editing with OpenMVS's
 * professional-grade multi-view texture projection, giving the best of both.
 */

import * as THREE from 'three';

// ============================================================================
// Types
// ============================================================================

export interface RenovationViewpoint {
  position: THREE.Vector3;
  target: THREE.Vector3;
  up: THREE.Vector3;
  fov: number;
  name: string;
  originalImagePath?: string;  // If we have the original camera image
}

export interface RenderedView {
  viewpoint: RenovationViewpoint;
  imageDataUrl: string;
  width: number;
  height: number;
}

export interface EditedView {
  viewpoint: RenovationViewpoint;
  originalImageDataUrl: string;
  editedImageDataUrl: string;
  width: number;
  height: number;
}

export interface CameraIntrinsics {
  width: number;
  height: number;
  fx: number;  // Focal length X
  fy: number;  // Focal length Y
  cx: number;  // Principal point X
  cy: number;  // Principal point Y
}

export interface CameraExtrinsics {
  position: THREE.Vector3;
  rotation: THREE.Quaternion;
  // COLMAP format
  qw: number;
  qx: number;
  qy: number;
  qz: number;
  tx: number;
  ty: number;
  tz: number;
}

export interface RetexturingRequest {
  mesh: THREE.Mesh;
  scene: THREE.Scene;
  viewpoints: RenovationViewpoint[];
  renovationType: string;       // 'flooring', 'paint', etc.
  renovationOption: string;     // 'hardwood', 'white', etc.
  roomDimensions?: {            // Real-world dimensions for accurate material scaling
    width: number;
    length: number;
    height: number;
    unit: 'ft' | 'm';
  };
  customPrompt?: string;
  capturedImages?: string[];    // Pre-captured image data URLs from manual viewpoint capture
}

export interface RetexturingResult {
  success: boolean;
  originalMesh?: THREE.Mesh;
  retexturedMesh?: THREE.Mesh;
  newTextureUrl?: string;
  editedViews?: EditedView[];
  processingTimeMs?: number;
  error?: string;
}

// ============================================================================
// Constants
// ============================================================================

// Default viewpoints for use when camera positions not available
export const DEFAULT_VIEWPOINTS: Partial<RenovationViewpoint>[] = [
  // Top-down view (great for floors)
  { name: 'top-down', position: new THREE.Vector3(0, 5, 0), target: new THREE.Vector3(0, 0, 0), fov: 60 },
  // Corner views (4 corners looking at center)
  { name: 'corner-1', position: new THREE.Vector3(3, 2, 3), target: new THREE.Vector3(0, 0, 0), fov: 60 },
  { name: 'corner-2', position: new THREE.Vector3(-3, 2, 3), target: new THREE.Vector3(0, 0, 0), fov: 60 },
  { name: 'corner-3', position: new THREE.Vector3(3, 2, -3), target: new THREE.Vector3(0, 0, 0), fov: 60 },
  { name: 'corner-4', position: new THREE.Vector3(-3, 2, -3), target: new THREE.Vector3(0, 0, 0), fov: 60 },
  // Side views
  { name: 'side-1', position: new THREE.Vector3(4, 1.5, 0), target: new THREE.Vector3(0, 0, 0), fov: 60 },
  { name: 'side-2', position: new THREE.Vector3(-4, 1.5, 0), target: new THREE.Vector3(0, 0, 0), fov: 60 },
  { name: 'side-3', position: new THREE.Vector3(0, 1.5, 4), target: new THREE.Vector3(0, 0, 0), fov: 60 },
  { name: 'side-4', position: new THREE.Vector3(0, 1.5, -4), target: new THREE.Vector3(0, 0, 0), fov: 60 },
  // Low angle views (good for seeing floor detail)
  { name: 'low-1', position: new THREE.Vector3(2, 0.5, 2), target: new THREE.Vector3(0, 0, 0), fov: 75 },
  { name: 'low-2', position: new THREE.Vector3(-2, 0.5, -2), target: new THREE.Vector3(0, 0, 0), fov: 75 },
];

const RENDER_WIDTH = 1920;
const RENDER_HEIGHT = 1080;

// ============================================================================
// Helper: Export Mesh to OBJ Format
// ============================================================================

/**
 * Export a Three.js mesh to OBJ format string.
 */
function exportMeshToOBJ(mesh: THREE.Mesh): string {
  const geometry = mesh.geometry;
  const positions = geometry.getAttribute('position');
  const normals = geometry.getAttribute('normal');
  const uvs = geometry.getAttribute('uv');
  const indices = geometry.getIndex();
  
  let obj = '# OBJ file exported from Three.js\n';
  obj += `# Vertices: ${positions.count}\n\n`;
  
  // Export vertices
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i);
    const y = positions.getY(i);
    const z = positions.getZ(i);
    obj += `v ${x.toFixed(6)} ${y.toFixed(6)} ${z.toFixed(6)}\n`;
  }
  obj += '\n';
  
  // Export texture coordinates
  if (uvs) {
    for (let i = 0; i < uvs.count; i++) {
      const u = uvs.getX(i);
      const v = uvs.getY(i);
      obj += `vt ${u.toFixed(6)} ${v.toFixed(6)}\n`;
    }
    obj += '\n';
  }
  
  // Export normals
  if (normals) {
    for (let i = 0; i < normals.count; i++) {
      const nx = normals.getX(i);
      const ny = normals.getY(i);
      const nz = normals.getZ(i);
      obj += `vn ${nx.toFixed(6)} ${ny.toFixed(6)} ${nz.toFixed(6)}\n`;
    }
    obj += '\n';
  }
  
  // Export faces
  const hasUVs = !!uvs;
  const hasNormals = !!normals;
  
  if (indices) {
    // Indexed geometry
    for (let i = 0; i < indices.count; i += 3) {
      const a = indices.getX(i) + 1;  // OBJ indices are 1-based
      const b = indices.getX(i + 1) + 1;
      const c = indices.getX(i + 2) + 1;
      
      if (hasUVs && hasNormals) {
        obj += `f ${a}/${a}/${a} ${b}/${b}/${b} ${c}/${c}/${c}\n`;
      } else if (hasUVs) {
        obj += `f ${a}/${a} ${b}/${b} ${c}/${c}\n`;
      } else if (hasNormals) {
        obj += `f ${a}//${a} ${b}//${b} ${c}//${c}\n`;
      } else {
        obj += `f ${a} ${b} ${c}\n`;
      }
    }
  } else {
    // Non-indexed geometry
    for (let i = 0; i < positions.count; i += 3) {
      const a = i + 1;  // OBJ indices are 1-based
      const b = i + 2;
      const c = i + 3;
      
      if (hasUVs && hasNormals) {
        obj += `f ${a}/${a}/${a} ${b}/${b}/${b} ${c}/${c}/${c}\n`;
      } else if (hasUVs) {
        obj += `f ${a}/${a} ${b}/${b} ${c}/${c}\n`;
      } else if (hasNormals) {
        obj += `f ${a}//${a} ${b}//${b} ${c}//${c}\n`;
      } else {
        obj += `f ${a} ${b} ${c}\n`;
      }
    }
  }
  
  console.log(`[RenovationRetexturing] Exported mesh: ${positions.count} vertices, ${(indices?.count || positions.count) / 3} faces`);
  
  return obj;
}

/**
 * Load the retextured OBJ mesh with its new texture from URLs.
 */
async function loadRetexturedOBJ(
  objUrl: string,
  textureUrl: string
): Promise<THREE.Mesh> {
  console.log('[RenovationRetexturing] Loading retextured mesh...');
  
  // Dynamically import OBJLoader and MTLLoader
  const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
  const { MTLLoader } = await import('three/examples/jsm/loaders/MTLLoader.js');
  
  // Derive MTL URL from OBJ URL
  const mtlUrl = objUrl.replace('.obj', '.mtl');
  const baseUrl = objUrl.substring(0, objUrl.lastIndexOf('/') + 1);
  
  console.log('[RenovationRetexturing] Loading MTL from:', mtlUrl);
  console.log('[RenovationRetexturing] Base URL:', baseUrl);
  
  // Load MTL first to get materials
  const mtlLoader = new MTLLoader();
  mtlLoader.setPath(baseUrl);
  
  const mtlFileName = mtlUrl.substring(mtlUrl.lastIndexOf('/') + 1);
  
  const materials = await new Promise<any>((resolve) => {
    mtlLoader.load(
      mtlFileName,
      (mtl) => {
        mtl.preload();
        console.log('[RenovationRetexturing] ✅ MTL loaded with materials:', Object.keys(mtl.materials));
        // Check the actual material properties
        for (const matName of Object.keys(mtl.materials)) {
          const mat = mtl.materials[matName] as any;
          console.log('[RenovationRetexturing] Material', matName, ':', {
            hasMap: !!mat.map,
            mapUrl: mat.map?.image?.src || 'none',
            color: mat.color?.getHexString?.() || 'unknown',
          });
        }
        resolve(mtl);
      },
      undefined,
      (error) => {
        console.warn('[RenovationRetexturing] MTL load failed, will use manual texture:', error);
        resolve(null);
      }
    );
  });
  
  // Load OBJ mesh with materials
  const objLoader = new OBJLoader();
  if (materials) {
    objLoader.setMaterials(materials);
  }
  
  const group = await new Promise<THREE.Group>((resolve, reject) => {
    objLoader.load(objUrl, resolve, undefined, reject);
  });
  
  console.log('[RenovationRetexturing] ✅ OBJ loaded');
  console.log('[RenovationRetexturing] Group children count:', group.children.length);
  
  // Extract the first mesh from the loaded group
  let loadedMesh: THREE.Mesh | null = null;
  let meshCount = 0;
  group.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      meshCount++;
      if (!loadedMesh) {
        loadedMesh = child;
        
        // Log mesh info
        console.log('[RenovationRetexturing] Found mesh:', {
          name: child.name,
          vertexCount: child.geometry.attributes.position?.count || 0,
          hasUVs: !!child.geometry.attributes.uv,
          materialType: child.material?.type,
        });
        
        // Compute bounding box for the loaded mesh
        child.geometry.computeBoundingBox();
        const bbox = child.geometry.boundingBox;
        if (bbox) {
          console.log('[RenovationRetexturing] Mesh bounding box:', {
            min: [bbox.min.x.toFixed(2), bbox.min.y.toFixed(2), bbox.min.z.toFixed(2)],
            max: [bbox.max.x.toFixed(2), bbox.max.y.toFixed(2), bbox.max.z.toFixed(2)],
          });
        }
        
        // Ensure texture settings are correct
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        for (const mat of mats) {
          const material = mat as any; // Cast to bypass TypeScript checks for material properties
          if (material.map) {
            material.map.colorSpace = THREE.SRGBColorSpace;
            material.map.flipY = false;
            material.map.needsUpdate = true;
            console.log('[RenovationRetexturing] ✅ Material has texture map, dimensions:', material.map.image?.width, 'x', material.map.image?.height);
          } else {
            console.log('[RenovationRetexturing] ⚠️ Material has NO texture map');
          }
          material.side = THREE.DoubleSide;
          // CRITICAL: Fix opacity issues - MTL files sometimes set opacity=0
          material.transparent = false;
          material.opacity = 1.0;
          material.needsUpdate = true;
        }
      }
    }
  });
  
  console.log('[RenovationRetexturing] Total meshes found:', meshCount);
  
  if (!loadedMesh) {
    throw new Error('No mesh found in loaded OBJ');
  }
  
  // Check if texture URL is provided
  if (!textureUrl) {
    console.warn('[RenovationRetexturing] ⚠️ No texture URL provided - mesh will have default material (likely orange)');
    // Apply a default gray material so it's at least visible
    const defaultMaterial = new THREE.MeshStandardMaterial({
      color: 0x888888,
      side: THREE.DoubleSide,
      roughness: 0.7,
      metalness: 0.1,
    });
    (loadedMesh as any).material = defaultMaterial;
    console.log('[RenovationRetexturing] Applied fallback gray material');
    return loadedMesh;
  }
  
  // ALWAYS manually load and apply texture - MTL auto-loading is unreliable
  // Even if MTL loaded, the texture path resolution often fails
  console.log('[RenovationRetexturing] Manually loading texture from:', textureUrl);
  const textureLoader = new THREE.TextureLoader();
  const texture = await new Promise<THREE.Texture>((resolve, reject) => {
    textureLoader.load(
      textureUrl,
      (tex) => {
        console.log('[RenovationRetexturing] ✅ Texture loaded:', tex.image?.width, 'x', tex.image?.height);
        tex.flipY = false;
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.needsUpdate = true;
        resolve(tex);
      },
      undefined,
      (error) => {
        console.error('[RenovationRetexturing] ❌ Texture load failed:', error);
        reject(error);
      }
    );
  });
  
  // Create a new material with the texture and apply it
  const newMaterial = new THREE.MeshStandardMaterial({
    map: texture,
    side: THREE.DoubleSide,
    roughness: 0.7,
    metalness: 0.1,
    transparent: false,
    opacity: 1.0,
  });
  
  (loadedMesh as any).material = newMaterial;
  console.log('[RenovationRetexturing] ✅ Applied new material with texture');
  
  // Final mesh debugging - cast to any to avoid TypeScript strict checking
  const mesh = loadedMesh as any;
  console.log('[RenovationRetexturing] 🔍 Final mesh properties:');
  console.log('  - Geometry vertices:', mesh.geometry?.attributes?.position?.count || 0);
  console.log('  - Geometry has normals:', !!mesh.geometry?.attributes?.normal);
  console.log('  - Geometry has UVs:', !!mesh.geometry?.attributes?.uv);
  console.log('  - Material type:', mesh.material?.type || 'unknown');
  console.log('  - Material visible:', mesh.material?.visible);
  console.log('  - Material transparent:', mesh.material?.transparent);
  console.log('  - Material opacity:', mesh.material?.opacity);
  console.log('  - Material side:', mesh.material?.side);
  console.log('  - Mesh visible:', mesh.visible);
  console.log('  - Mesh renderOrder:', mesh.renderOrder);
  console.log('  - Mesh frustumCulled:', mesh.frustumCulled);
  
  // Compute bounding sphere for camera distance check
  if (mesh.geometry && !mesh.geometry.boundingSphere) {
    mesh.geometry.computeBoundingSphere();
  }
  console.log('  - Bounding sphere radius:', mesh.geometry?.boundingSphere?.radius || 0);
  
  console.log('[RenovationRetexturing] ✅ Retextured mesh ready');
  
  return loadedMesh;
}

// ============================================================================
// Step 1: Render Mesh from Multiple Viewpoints
// ============================================================================

/**
 * Render the mesh from multiple viewpoints to create source images for Gemini editing.
 */
export function renderMeshViewpoints(
  mesh: THREE.Mesh,  // The original mesh to render
  scene: THREE.Scene,
  viewpoints: RenovationViewpoint[],
  width: number = RENDER_WIDTH,
  height: number = RENDER_HEIGHT
): RenderedView[] {
  console.log(`[RenovationRetexturing] Rendering ${viewpoints.length} viewpoints...`);
  
  // Debug mesh info
  mesh.geometry.computeBoundingBox();
  const bbox = mesh.geometry.boundingBox!;
  console.log(`[RenovationRetexturing] Mesh bounding box:`, {
    min: { x: bbox.min.x.toFixed(2), y: bbox.min.y.toFixed(2), z: bbox.min.z.toFixed(2) },
    max: { x: bbox.max.x.toFixed(2), y: bbox.max.y.toFixed(2), z: bbox.max.z.toFixed(2) }
  });
  console.log(`[RenovationRetexturing] Scene children:`, scene.children.length);
  
  const renderedViews: RenderedView[] = [];
  
  // Create an offscreen canvas for rendering
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  
  // Create an offscreen renderer with the canvas
  const renderer = new THREE.WebGLRenderer({ 
    canvas,
    antialias: true, 
    preserveDrawingBuffer: true,
    alpha: false 
  });
  renderer.setSize(width, height);
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  
  // Create camera
  const camera = new THREE.PerspectiveCamera(60, width / height, 0.01, 1000);
  
  // CRITICAL: Set material to double-sided for interior views
  // When camera is inside the room, we need to see back faces of walls
  if (mesh.material) {
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (material instanceof THREE.MeshStandardMaterial || 
          material instanceof THREE.MeshBasicMaterial ||
          material instanceof THREE.MeshPhongMaterial) {
        material.side = THREE.DoubleSide;
        material.needsUpdate = true;
        if (material.map) {
          console.log(`[RenovationRetexturing] Mesh has texture map, set to DoubleSide`);
        } else {
          console.log(`[RenovationRetexturing] Mesh has no texture map (using color), set to DoubleSide`);
        }
      }
    }
  }
  
  // Add stronger lighting
  const ambientLight = new THREE.AmbientLight(0xffffff, 1.0);
  const directionalLight = new THREE.DirectionalLight(0xffffff, 1.0);
  directionalLight.position.set(10, 10, 10);
  scene.add(ambientLight);
  scene.add(directionalLight);
  
  for (const viewpoint of viewpoints) {
    // Set camera position and orientation
    camera.position.copy(viewpoint.position);
    camera.fov = viewpoint.fov || 60;
    camera.updateProjectionMatrix();
    
    // Set up vector before lookAt
    if (viewpoint.up) {
      camera.up.copy(viewpoint.up);
    }
    camera.lookAt(viewpoint.target);
    
    console.log(`[RenovationRetexturing] Camera for ${viewpoint.name}:`, {
      pos: { x: camera.position.x.toFixed(2), y: camera.position.y.toFixed(2), z: camera.position.z.toFixed(2) },
      target: { x: viewpoint.target.x.toFixed(2), y: viewpoint.target.y.toFixed(2), z: viewpoint.target.z.toFixed(2) }
    });
    
    // Render the scene
    renderer.render(scene, camera);
    
    // Capture as data URL
    const imageDataUrl = canvas.toDataURL('image/png');
    
    renderedViews.push({
      viewpoint,
      imageDataUrl,
      width,
      height,
    });
    
    console.log(`[RenovationRetexturing] Rendered view: ${viewpoint.name} (${imageDataUrl.length} bytes)`);
  }
  
  // Cleanup
  scene.remove(ambientLight);
  scene.remove(directionalLight);
  renderer.dispose();
  
  console.log(`[RenovationRetexturing] ✅ Rendered ${renderedViews.length} views`);
  return renderedViews;
}

/**
 * Generate viewpoints based on mesh bounding box.
 * Creates evenly distributed viewpoints around the mesh.
 * For interior room scans, cameras are positioned INSIDE looking outward.
 */
export function generateViewpointsForMesh(
  mesh: THREE.Mesh,
  numViewpoints: number = 40  // Increased from 10 to 40 for better coverage
): RenovationViewpoint[] {
  console.log('[RenovationRetexturing] Generating INTERIOR viewpoints for mesh...');
  
  // IMPORTANT: Update world matrix to ensure transforms are current
  mesh.updateMatrixWorld(true);
  
  // Get mesh bounding box in WORLD coordinates (not local)
  mesh.geometry.computeBoundingBox();
  const localBbox = mesh.geometry.boundingBox!;
  
  // Create a Box3 and transform it to world space
  const worldBbox = new THREE.Box3();
  worldBbox.copy(localBbox).applyMatrix4(mesh.matrixWorld);
  
  const center = new THREE.Vector3();
  worldBbox.getCenter(center);
  const size = new THREE.Vector3();
  worldBbox.getSize(size);
  
  console.log(`[RenovationRetexturing] Local bounds: min(${localBbox.min.x.toFixed(2)}, ${localBbox.min.y.toFixed(2)}, ${localBbox.min.z.toFixed(2)}) max(${localBbox.max.x.toFixed(2)}, ${localBbox.max.y.toFixed(2)}, ${localBbox.max.z.toFixed(2)})`);
  console.log(`[RenovationRetexturing] WORLD bounds: min(${worldBbox.min.x.toFixed(2)}, ${worldBbox.min.y.toFixed(2)}, ${worldBbox.min.z.toFixed(2)}) max(${worldBbox.max.x.toFixed(2)}, ${worldBbox.max.y.toFixed(2)}, ${worldBbox.max.z.toFixed(2)})`);
  console.log(`[RenovationRetexturing] WORLD center: (${center.x.toFixed(2)}, ${center.y.toFixed(2)}, ${center.z.toFixed(2)})`);
  console.log(`[RenovationRetexturing] WORLD size: (${size.x.toFixed(2)}, ${size.y.toFixed(2)}, ${size.z.toFixed(2)})`);
  console.log(`[RenovationRetexturing] Mesh world position: (${mesh.position.x.toFixed(2)}, ${mesh.position.y.toFixed(2)}, ${mesh.position.z.toFixed(2)})`);
  
  // For interior room scans, camera should be inside the room
  const floorY = worldBbox.min.y;
  const ceilingY = worldBbox.max.y;
  const roomHeight = ceilingY - floorY;
  
  // Eye height should be relative to floor, around 1.6m or 50% of room height (whichever fits)
  const eyeHeight = Math.min(1.6, roomHeight * 0.5);
  const cameraY = floorY + eyeHeight;
  
  console.log(`[RenovationRetexturing] Floor Y: ${floorY.toFixed(2)}, Ceiling Y: ${ceilingY.toFixed(2)}, Room height: ${roomHeight.toFixed(2)}`);
  console.log(`[RenovationRetexturing] Camera Y: ${cameraY.toFixed(2)}`);
  
  const viewpoints: RenovationViewpoint[] = [];
  
  // The mesh center is where we want the camera for interior views
  // (camera inside the room, looking at walls)
  
  // 1. Top-down view looking at the floor (essential for flooring renovation)
  // Position camera above the center, looking down at floor
  const topDownY = ceilingY + Math.max(size.x, size.z); // High above to see entire floor
  viewpoints.push({
    name: 'floor-view',
    position: new THREE.Vector3(center.x, topDownY, center.z),
    target: new THREE.Vector3(center.x, floorY, center.z),
    up: new THREE.Vector3(0, 0, -1),
    fov: 90,
  });
  
  console.log(`[RenovationRetexturing] Floor-view camera at Y=${topDownY.toFixed(2)}, looking at floor Y=${floorY.toFixed(2)}`);
  
  // 2. Generate multi-level views with varying heights for complete coverage
  // Distribute remaining viewpoints across 3 height levels
  const remainingViews = numViewpoints - 1;
  const viewsPerLevel = Math.ceil(remainingViews / 3);
  
  // Height levels: low (floor level), mid (eye height), high (near ceiling)
  const heights = [
    floorY + roomHeight * 0.2,   // Low: ~20% up from floor
    cameraY,                      // Mid: eye height (~50%)
    floorY + roomHeight * 0.8,   // High: ~80% up (near ceiling)
  ];
  
  const lookDistanceX = size.x * 0.45;
  const lookDistanceZ = size.z * 0.45;
  
  let viewIndex = 0;
  for (const height of heights) {
    const viewsAtThisHeight = Math.min(viewsPerLevel, remainingViews - viewIndex);
    
    for (let i = 0; i < viewsAtThisHeight; i++) {
      const angle = (viewIndex / remainingViews) * Math.PI * 2;
      
      // Camera at center of room at current height level
      const camPos = new THREE.Vector3(center.x, height, center.z);
      
      // Looking outward toward walls
      const lookX = center.x + Math.cos(angle) * lookDistanceX;
      const lookZ = center.z + Math.sin(angle) * lookDistanceZ;
      
      // Look slightly toward the middle vertical range
      const lookY = floorY + roomHeight * 0.5;
      
      const targetPos = new THREE.Vector3(lookX, lookY, lookZ);
      
      viewpoints.push({
        name: `interior-h${heights.indexOf(height)}-${i}`,
        position: camPos.clone(),
        target: targetPos,
        up: new THREE.Vector3(0, 1, 0),
        fov: 90,
      });
      
      viewIndex++;
      if (viewIndex >= remainingViews) break;
    }
    if (viewIndex >= remainingViews) break;
  }
  
  console.log(`[RenovationRetexturing] Generated ${viewpoints.length} viewpoints across ${heights.length} height levels`);
  
  return viewpoints;
}

// ============================================================================
// Step 2: Send Views to Gemini for Renovation Editing
// ============================================================================

/**
 * Build a renovation prompt with room dimensions for accurate material placement.
 * Uses a conversational style that works well with Gemini image editing.
 */
function buildRenovationPrompt(
  renovationType: string,
  renovationOption: string,
  roomDimensions?: { width: number; length: number; height: number; unit: string },
  customPrompt?: string
): string {
  // If custom prompt provided, use it directly
  if (customPrompt) {
    return customPrompt;
  }
  
  const materialDescriptions: Record<string, Record<string, string>> = {
    flooring: {
      hardwood: 'hardwood floor',
      walnut: 'dark walnut hardwood floor',
      tile: 'tile floor',
      marble: 'marble floor',
      vinyl: 'vinyl plank floor',
      carpet: 'carpet',
    },
    paint: {
      white: 'white paint on the walls',
      gray: 'gray paint on the walls',
      beige: 'beige paint on the walls',
      navy: 'navy blue paint on the walls',
      sage: 'sage green paint on the walls',
    },
  };
  
  const materialDesc = materialDescriptions[renovationType]?.[renovationOption] ||
    `${renovationOption} ${renovationType}`;
  
  // Use the proven conversational prompt style that works with Gemini
  let prompt = `Can you give this room a ${materialDesc}`;
  
  if (roomDimensions && renovationType === 'flooring') {
    const { width, length, unit } = roomDimensions;
    prompt += ` but make sure that you use the exact room dimensions shown (${width.toFixed(1)} x ${length.toFixed(1)} ${unit}) to have a real world accurate number of ${renovationOption === 'tile' || renovationOption === 'marble' ? 'tiles' : 'wood panels'} necessary for this room`;
  }
  
  prompt += `. Also don't change the look of anything else in the room besides adding this ${materialDesc}, I want to see how the room will look with this renovation applied.`;

  return prompt;
}

/**
 * Send a rendered view to Gemini for renovation editing with retry logic.
 */
export async function editViewWithGemini(
  renderedView: RenderedView,
  renovationType: string,
  renovationOption: string,
  roomDimensions?: { width: number; length: number; height: number; unit: 'ft' | 'm' },
  customPrompt?: string,
  maxRetries: number = 3
): Promise<EditedView> {
  console.log(`[RenovationRetexturing] Editing view: ${renderedView.viewpoint.name}`);
  
  const prompt = buildRenovationPrompt(renovationType, renovationOption, roomDimensions, customPrompt);
  
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        // Exponential backoff: 2s, 4s, 8s...
        const delay = 2000 * Math.pow(2, attempt - 1);
        console.log(`[RenovationRetexturing] Retry ${attempt}/${maxRetries} for ${renderedView.viewpoint.name} after ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      
      const response = await fetch('/api/renovation-preview/edit-view-for-retexturing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageDataUrl: renderedView.imageDataUrl,
          prompt,
          renovationType,
          renovationOption,
          viewName: renderedView.viewpoint.name,
        }),
      });
      
      if (!response.ok) {
        const errorText = await response.text().catch(() => response.statusText);
        throw new Error(`View editing failed (${response.status}): ${errorText}`);
      }
      
      const result = await response.json();
      
      if (!result.success || !result.editedImageUrl) {
        throw new Error(result.error || `Failed to edit view: ${renderedView.viewpoint.name}`);
      }
      
      console.log(`[RenovationRetexturing] ✅ View edited: ${renderedView.viewpoint.name}`);
      
      return {
        viewpoint: renderedView.viewpoint,
        originalImageDataUrl: renderedView.imageDataUrl,
        editedImageDataUrl: result.editedImageUrl,
        width: renderedView.width,
        height: renderedView.height,
      };
    } catch (error: any) {
      lastError = error;
      console.warn(`[RenovationRetexturing] Attempt ${attempt + 1} failed for ${renderedView.viewpoint.name}: ${error.message}`);
      
      // Don't retry on non-retryable errors (400 = bad request, not server issue)
      if (error.message.includes('400') || error.message.includes('Invalid')) {
        throw error;
      }
      
      // For 429 (rate limit), use longer backoff
      if (error.message.includes('429') || error.message.includes('Rate limited')) {
        const rateLimitDelay = 5000 * Math.pow(2, attempt); // 5s, 10s, 20s
        console.log(`[RenovationRetexturing] Rate limited, waiting ${rateLimitDelay}ms...`);
        await new Promise(resolve => setTimeout(resolve, rateLimitDelay));
      }
    }
  }
  
  throw lastError || new Error(`Failed to edit view after ${maxRetries} attempts`);
}

/**
 * Edit all rendered views with Gemini (with parallelization).
 */
export async function editAllViewsWithGemini(
  renderedViews: RenderedView[],
  renovationType: string,
  renovationOption: string,
  roomDimensions?: { width: number; length: number; height: number; unit: 'ft' | 'm' },
  customPrompt?: string,
  progressCallback?: (current: number, total: number) => void
): Promise<EditedView[]> {
  console.log(`[RenovationRetexturing] Editing ${renderedViews.length} views with Gemini...`);
  
  const editedViews: EditedView[] = [];
  
  // Process in batches of 2 to avoid rate limiting, with delay between batches
  const batchSize = 2;
  for (let i = 0; i < renderedViews.length; i += batchSize) {
    const batch = renderedViews.slice(i, i + batchSize);
    
    try {
      const batchResults = await Promise.all(
        batch.map(async (view) => {
          try {
            return await editViewWithGemini(view, renovationType, renovationOption, roomDimensions, customPrompt);
          } catch (error: any) {
            console.warn(`[RenovationRetexturing] ⚠️ Failed to edit view ${view.viewpoint.name}: ${error.message}`);
            // Return a placeholder for failed views instead of throwing
            return {
              viewpoint: view.viewpoint,
              originalImageDataUrl: view.imageDataUrl,
              editedImageDataUrl: view.imageDataUrl, // Use original as fallback
              width: view.width,
              height: view.height,
            } as EditedView;
          }
        })
      );
      
      editedViews.push(...batchResults);
      
      if (progressCallback) {
        progressCallback(Math.min(i + batchSize, renderedViews.length), renderedViews.length);
      }
      
      // Add delay between batches to avoid rate limiting
      if (i + batchSize < renderedViews.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (batchError: any) {
      console.error(`[RenovationRetexturing] Batch ${i / batchSize + 1} failed:`, batchError.message);
      // Continue with remaining batches
    }
  }
  
  if (editedViews.length === 0) {
    throw new Error('All view edits failed');
  }
  
  console.log(`[RenovationRetexturing] ✅ ${editedViews.length}/${renderedViews.length} views edited`);
  return editedViews;
}

// ============================================================================
// Step 3: Export Camera Data for OpenMVS
// ============================================================================

/**
 * Convert Three.js camera to COLMAP/OpenMVS format.
 * OpenMVS uses the same camera conventions as COLMAP.
 */
export function convertCameraToColmapFormat(
  viewpoint: RenovationViewpoint,
  imageWidth: number,
  imageHeight: number
): { intrinsics: CameraIntrinsics; extrinsics: CameraExtrinsics } {
  // Calculate intrinsics from FOV
  const fovRad = (viewpoint.fov * Math.PI) / 180;
  const fy = imageHeight / (2 * Math.tan(fovRad / 2));
  const fx = fy;  // Assuming square pixels
  const cx = imageWidth / 2;
  const cy = imageHeight / 2;
  
  // Calculate rotation from position -> target
  const direction = new THREE.Vector3();
  direction.subVectors(viewpoint.target, viewpoint.position).normalize();
  
  // Create rotation quaternion
  const up = viewpoint.up || new THREE.Vector3(0, 1, 0);
  const matrix = new THREE.Matrix4();
  matrix.lookAt(viewpoint.position, viewpoint.target, up);
  const quaternion = new THREE.Quaternion();
  quaternion.setFromRotationMatrix(matrix);
  
  // COLMAP uses a different camera coordinate system (right-down-forward)
  // Need to apply a conversion
  const colmapQuat = new THREE.Quaternion();
  const flipMatrix = new THREE.Matrix4().makeRotationX(Math.PI);
  const flipQuat = new THREE.Quaternion().setFromRotationMatrix(flipMatrix);
  colmapQuat.multiplyQuaternions(quaternion, flipQuat);
  
  return {
    intrinsics: {
      width: imageWidth,
      height: imageHeight,
      fx,
      fy,
      cx,
      cy,
    },
    extrinsics: {
      position: viewpoint.position.clone(),
      rotation: colmapQuat,
      qw: colmapQuat.w,
      qx: colmapQuat.x,
      qy: colmapQuat.y,
      qz: colmapQuat.z,
      tx: viewpoint.position.x,
      ty: viewpoint.position.y,
      tz: viewpoint.position.z,
    },
  };
}

// ============================================================================
// Step 4: Trigger OpenMVS Retexturing on GCP
// ============================================================================

/**
 * Upload edited images and trigger OpenMVS TextureMesh on GCP.
 * Returns the URL of the retextured mesh.
 */
export async function triggerGcpRetexturing(
  editedViews: EditedView[],
  mesh: THREE.Mesh,  // The actual mesh object to export
  progressCallback?: (status: string) => void
): Promise<{ texturedMeshUrl: string; textureUrl: string }> {
  console.log('[RenovationRetexturing] Triggering GCP retexturing pipeline...');
  
  if (progressCallback) progressCallback('Uploading edited views to server...');
  
  // Export mesh to OBJ format
  const meshObjData = exportMeshToOBJ(mesh);
  
  // Prepare camera data
  // Note: Gemini returns images as PNG, so we use .png extension
  const cameraData = editedViews.map((view, index) => {
    const { intrinsics, extrinsics } = convertCameraToColmapFormat(
      view.viewpoint,
      view.width,
      view.height
    );
    return {
      imageIndex: index,
      imageName: `view_${String(index).padStart(4, '0')}.png`,
      viewName: view.viewpoint.name,
      intrinsics,
      extrinsics,
    };
  });
  
  // Send to server for GCP processing
  const response = await fetch('/api/renovation-preview/retexture-on-gcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      editedImages: editedViews.map((v, i) => ({
        name: `view_${String(i).padStart(4, '0')}.png`,
        dataUrl: v.editedImageDataUrl,
      })),
      cameraData,
      meshObjData,  // OBJ format string
    }),
  });
  
  if (!response.ok) {
    throw new Error(`GCP retexturing failed: ${response.statusText}`);
  }
  
  const result = await response.json();
  
  if (!result.success) {
    throw new Error(result.error || 'GCP retexturing failed');
  }
  
  console.log('[RenovationRetexturing] ✅ GCP retexturing complete');
  
  return {
    texturedMeshUrl: result.texturedMeshUrl,
    textureUrl: result.textureUrl,
  };
}

// ============================================================================
// Main Orchestration Function
// ============================================================================

/**
 * Complete renovation retexturing pipeline.
 * This is the main entry point for the multi-view renovation approach.
 */
export async function performRenovationRetexturing(
  request: RetexturingRequest,
  progressCallback?: (stage: string, progress: number) => void
): Promise<RetexturingResult> {
  const startTime = Date.now();
  console.log('[RenovationRetexturing] Starting multi-view renovation pipeline...');
  console.log(`[RenovationRetexturing] Renovation: ${request.renovationType} -> ${request.renovationOption}`);
  
  try {
    // Step 1: Generate viewpoints if not provided
    const viewpoints = request.viewpoints.length > 0 
      ? request.viewpoints 
      : generateViewpointsForMesh(request.mesh);
    
    if (progressCallback) progressCallback('Rendering viewpoints', 0.1);
    
    // Step 2: Either use pre-captured images or render mesh from all viewpoints
    // If manual captures are provided but count is less than auto-generated viewpoints,
    // supplement with automatic renders for complete coverage
    let renderedViews: RenderedView[];
    
    if (request.capturedImages && request.capturedImages.length > 0) {
      // Use pre-captured images from manual viewpoint capture
      console.log(`[RenovationRetexturing] 📸 Using ${request.capturedImages.length} pre-captured images`);
      
      // Use manual captures for first N viewpoints
      renderedViews = viewpoints.slice(0, request.capturedImages.length).map((vp, idx) => ({
        viewpoint: vp,
        imageDataUrl: request.capturedImages![idx],
        width: 1920,
        height: 1080,
      }));
      
      // If we have more viewpoints than captures, render the remaining views
      if (viewpoints.length > request.capturedImages!.length) {
        console.log(`[RenovationRetexturing] 🎨 Supplementing with ${viewpoints.length - request.capturedImages!.length} automatic renders for complete coverage`);
        const remainingViewpoints = viewpoints.slice(request.capturedImages!.length);
        const additionalViews = await renderMeshViewpoints(request.mesh, request.scene, remainingViewpoints);
        renderedViews.push(...additionalViews);
        console.log(`[RenovationRetexturing] Total views: ${renderedViews.length} (${request.capturedImages!.length} manual + ${additionalViews.length} auto)`);
      }
    } else {
      // Render mesh from all viewpoints
      console.log('[RenovationRetexturing] 🔄 Rendering mesh from viewpoints');
      renderedViews = renderMeshViewpoints(
        request.mesh,
        request.scene,
        viewpoints
      );
    }
    
    if (progressCallback) progressCallback('Editing with Gemini', 0.2);
    
    // Step 3: Edit all views with Gemini
    const editedViews = await editAllViewsWithGemini(
      renderedViews,
      request.renovationType,
      request.renovationOption,
      request.roomDimensions,
      request.customPrompt,
      (current, total) => {
        if (progressCallback) {
          progressCallback(`Editing views (${current}/${total})`, 0.2 + (current / total) * 0.5);
        }
      }
    );
    
    if (progressCallback) progressCallback('Retexturing on GCP', 0.7);
    
    // Step 4: Trigger GCP retexturing with the mesh
    const gcpResult = await triggerGcpRetexturing(
      editedViews,
      request.mesh,
      (status) => {
        if (progressCallback) progressCallback(status, 0.8);
      }
    );
    
    if (progressCallback) progressCallback('Loading retextured mesh', 0.9);
    
    // Step 5: Load the retextured mesh
    console.log(`[RenovationRetexturing] Loading retextured mesh from: ${gcpResult.texturedMeshUrl}`);
    console.log(`[RenovationRetexturing] New texture URL: ${gcpResult.textureUrl}`);
    
    // Load the new OBJ mesh and texture
    const retexturedMesh = await loadRetexturedOBJ(
      gcpResult.texturedMeshUrl,
      gcpResult.textureUrl
    );
    
    const processingTimeMs = Date.now() - startTime;
    console.log(`[RenovationRetexturing] ✅ Complete in ${(processingTimeMs / 1000).toFixed(1)}s`);
    
    if (progressCallback) progressCallback('Complete', 1.0);
    
    return {
      success: true,
      originalMesh: request.mesh,
      retexturedMesh,
      newTextureUrl: gcpResult.textureUrl,
      editedViews,
      processingTimeMs,
    };
    
  } catch (error) {
    console.error('[RenovationRetexturing] Pipeline failed:', error);
    throw error;
  }
}

// ============================================================================
// Quick Preview Mode (Client-Side Only)
// ============================================================================

/**
 * Quick preview mode that just shows the Gemini-edited views without GCP retexturing.
 * Useful for fast iteration before committing to full retexturing.
 */
export async function quickPreviewRenovation(
  mesh: THREE.Mesh,
  scene: THREE.Scene,
  renovationType: string,
  renovationOption: string,
  roomDimensions?: { width: number; length: number; height: number; unit: 'ft' | 'm' },
  numViews: number = 4
): Promise<EditedView[]> {
  console.log('[RenovationRetexturing] Quick preview mode (client-side only)...');
  
  // Generate a small number of viewpoints
  const viewpoints = generateViewpointsForMesh(mesh, numViews);
  
  // Render views
  const renderedViews = renderMeshViewpoints(mesh, scene, viewpoints, 1280, 720);
  
  // Edit with Gemini
  const editedViews = await editAllViewsWithGemini(
    renderedViews,
    renovationType,
    renovationOption,
    roomDimensions
  );
  
  return editedViews;
}
