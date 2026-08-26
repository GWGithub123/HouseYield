/**
 * Floor Overlay Service
 * 
 * A simpler approach to floor renovation visualization:
 * 1. Capture room from multiple angles
 * 2. Gemini generates floor image with new material (understanding room context)
 * 3. Meshy Image-to-3D creates a 3D floor mesh
 * 4. Place the mesh in the scene at the correct position
 * 
 * No mesh segmentation required!
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';

export interface FloorBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  y: number; // Floor level
}

export interface FloorOverlayResult {
  floorImageUrl: string;
  floorModelUrl: string;
  meshyModelUrl?: string;
  thumbnailUrl?: string;
  placement: {
    x: number;
    y: number;
    z: number;
    width: number;
    depth: number;
  };
  materialKey: string;
  taskId: string;
}

export interface ViewportCapture {
  image: string; // Base64 data URL
  angle: 'top' | 'front' | 'side' | 'perspective';
  cameraPosition: THREE.Vector3;
}

/**
 * Capture the room from multiple angles for Gemini context
 */
export async function captureMultipleAngles(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  originalCamera: THREE.Camera,
  floorBounds: FloorBounds
): Promise<ViewportCapture[]> {
  const captures: ViewportCapture[] = [];
  
  // Create a temporary camera for captures
  const aspect = renderer.domElement.width / renderer.domElement.height;
  const tempCamera = new THREE.PerspectiveCamera(60, aspect, 0.1, 1000);
  
  // Room center
  const centerX = (floorBounds.minX + floorBounds.maxX) / 2;
  const centerZ = (floorBounds.minZ + floorBounds.maxZ) / 2;
  const roomWidth = floorBounds.maxX - floorBounds.minX;
  const roomDepth = floorBounds.maxZ - floorBounds.minZ;
  const roomSize = Math.max(roomWidth, roomDepth);
  
  // 1. Top-down view (most important for floor shape)
  const topHeight = roomSize * 1.5;
  tempCamera.position.set(centerX, floorBounds.y + topHeight, centerZ);
  tempCamera.lookAt(centerX, floorBounds.y, centerZ);
  tempCamera.up.set(0, 0, -1); // Align "up" with -Z for proper top-down orientation
  renderer.render(scene, tempCamera);
  captures.push({
    image: renderer.domElement.toDataURL('image/png'),
    angle: 'top',
    cameraPosition: tempCamera.position.clone()
  });
  
  // Reset up vector
  tempCamera.up.set(0, 1, 0);
  
  // 2. Perspective view (current user view - provides lighting context)
  renderer.render(scene, originalCamera);
  captures.push({
    image: renderer.domElement.toDataURL('image/png'),
    angle: 'perspective',
    cameraPosition: originalCamera.position.clone()
  });
  
  // 3. Front view
  const viewDistance = roomSize * 1.2;
  tempCamera.position.set(centerX, floorBounds.y + roomSize * 0.4, centerZ + viewDistance);
  tempCamera.lookAt(centerX, floorBounds.y, centerZ);
  renderer.render(scene, tempCamera);
  captures.push({
    image: renderer.domElement.toDataURL('image/png'),
    angle: 'front',
    cameraPosition: tempCamera.position.clone()
  });
  
  // 4. Side view
  tempCamera.position.set(centerX + viewDistance, floorBounds.y + roomSize * 0.4, centerZ);
  tempCamera.lookAt(centerX, floorBounds.y, centerZ);
  renderer.render(scene, tempCamera);
  captures.push({
    image: renderer.domElement.toDataURL('image/png'),
    angle: 'side',
    cameraPosition: tempCamera.position.clone()
  });
  
  console.log('[FloorOverlay] Captured', captures.length, 'viewport angles');
  
  return captures;
}

/**
 * Detect floor bounds from a mesh
 */
export function detectFloorBounds(mesh: THREE.Object3D): FloorBounds {
  const box = new THREE.Box3().setFromObject(mesh);
  
  // Floor is typically at the bottom 10% of the mesh
  const height = box.max.y - box.min.y;
  const floorY = box.min.y + height * 0.05; // Slightly above absolute minimum
  
  return {
    minX: box.min.x,
    maxX: box.max.x,
    minZ: box.min.z,
    maxZ: box.max.z,
    y: floorY
  };
}

/**
 * Generate floor image preview only (fast - no 3D generation)
 */
export async function generateFloorImagePreview(
  viewportImages: string[],
  materialKey: string,
  customPrompt?: string
): Promise<{ floorImageUrl: string; floorImageDataUrl: string }> {
  console.log('[FloorOverlay] Generating floor image preview...');
  
  const response = await fetch('/api/floor-overlay/generate-image-only', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      viewportImages,
      materialKey,
      customPrompt,
      roomContext: 'Interior room 3D scan for renovation visualization'
    })
  });
  
  const result = await response.json();
  
  if (!result.success) {
    throw new Error(result.error || 'Failed to generate floor image');
  }
  
  return {
    floorImageUrl: result.floorImageUrl,
    floorImageDataUrl: result.floorImageDataUrl
  };
}

/**
 * Full pipeline: Generate 3D floor overlay
 */
export async function generateFloorOverlay(
  viewportImages: string[],
  materialKey: string,
  floorBounds: FloorBounds,
  customPrompt?: string,
  onProgress?: (stage: string, percent: number) => void
): Promise<FloorOverlayResult> {
  console.log('[FloorOverlay] Starting floor overlay generation...');
  
  onProgress?.('Sending to Gemini...', 10);
  
  const response = await fetch('/api/floor-overlay/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      viewportImages,
      materialKey,
      customPrompt,
      floorBounds,
      roomContext: 'Interior room 3D scan for renovation visualization. This is a photogrammetry capture of a real room.'
    })
  });
  
  const result = await response.json();
  
  if (!result.success) {
    throw new Error(result.error || 'Failed to generate floor overlay');
  }
  
  onProgress?.('Floor overlay complete!', 100);
  
  return result as FloorOverlayResult;
}

/**
 * Load the generated floor model and add it to the scene
 */
export async function loadFloorIntoScene(
  scene: THREE.Scene,
  floorModelUrl: string,
  placement: FloorOverlayResult['placement'],
  floorBounds: FloorBounds
): Promise<THREE.Object3D> {
  console.log('[FloorOverlay] Loading floor model into scene...');
  console.log('[FloorOverlay] Model URL:', floorModelUrl);
  console.log('[FloorOverlay] Placement:', placement);
  
  return new Promise((resolve, reject) => {
    const isGLB = floorModelUrl.endsWith('.glb') || floorModelUrl.endsWith('.gltf');
    
    const processLoadedObject = (floorMesh: THREE.Object3D) => {
      // Calculate bounding box of the loaded model
      const modelBox = new THREE.Box3().setFromObject(floorMesh);
      const modelSize = new THREE.Vector3();
      modelBox.getSize(modelSize);
      
      // Calculate scale to match floor bounds
      const targetWidth = floorBounds.maxX - floorBounds.minX;
      const targetDepth = floorBounds.maxZ - floorBounds.minZ;
      
      const scaleX = targetWidth / modelSize.x;
      const scaleZ = targetDepth / modelSize.z;
      const scaleY = 0.01; // Flatten to near-zero height (it's a floor)
      
      floorMesh.scale.set(scaleX, scaleY, scaleZ);
      
      // Position at floor level
      const centerX = (floorBounds.minX + floorBounds.maxX) / 2;
      const centerZ = (floorBounds.minZ + floorBounds.maxZ) / 2;
      
      // Recalculate box after scaling
      const scaledBox = new THREE.Box3().setFromObject(floorMesh);
      
      // Position so bottom of mesh is at floor Y
      floorMesh.position.set(
        centerX - (scaledBox.min.x + scaledBox.max.x) / 2,
        floorBounds.y - scaledBox.min.y + 0.001, // Slightly above to prevent z-fighting
        centerZ - (scaledBox.min.z + scaledBox.max.z) / 2
      );
      
      // Mark as floor overlay for later identification
      floorMesh.name = 'floor-overlay';
      floorMesh.userData.isFloorOverlay = true;
      floorMesh.userData.materialKey = placement;
      
      // Add to scene
      scene.add(floorMesh);
      
      console.log('[FloorOverlay] ✅ Floor added to scene');
      console.log('[FloorOverlay] Position:', floorMesh.position);
      console.log('[FloorOverlay] Scale:', floorMesh.scale);
      
      resolve(floorMesh);
    };
    
    const onError = (error: any) => {
      console.error('[FloorOverlay] Failed to load floor model:', error);
      reject(error);
    };
    
    if (isGLB) {
      const loader = new GLTFLoader();
      loader.load(
        floorModelUrl, 
        (gltf) => processLoadedObject(gltf.scene), 
        undefined, 
        onError
      );
    } else {
      const loader = new OBJLoader();
      loader.load(floorModelUrl, processLoadedObject, undefined, onError);
    }
  });
}

/**
 * Remove floor overlay from scene
 */
export function removeFloorOverlay(scene: THREE.Scene): boolean {
  const overlay = scene.getObjectByName('floor-overlay');
  if (overlay) {
    scene.remove(overlay);
    // Dispose geometry and materials
    overlay.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry?.dispose();
        if (child.material) {
          if (Array.isArray(child.material)) {
            child.material.forEach(m => m.dispose());
          } else {
            child.material.dispose();
          }
        }
      }
    });
    console.log('[FloorOverlay] Removed floor overlay from scene');
    return true;
  }
  return false;
}

/**
 * Get available floor materials
 */
export async function getFloorMaterials(): Promise<Array<{ key: string; name: string; description: string }>> {
  const response = await fetch('/api/floor-overlay/materials');
  const result = await response.json();
  
  if (!result.success) {
    throw new Error('Failed to fetch materials');
  }
  
  return result.materials;
}
