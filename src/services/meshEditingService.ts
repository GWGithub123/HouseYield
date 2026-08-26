/**
 * Mesh Editing Service
 * 
 * Client-side interface for mesh editing operations:
 * - Furniture removal
 * - Room reshaping (cut doorways, windows)
 * - Mesh smoothing
 * - 3D selection tools
 */

import * as THREE from 'three';

// ============================================================================
// API Calls to Backend
// ============================================================================

export interface MeshEditResult {
  success: boolean;
  outputUrl?: string;
  error?: string;
  jobId?: string;
  stats?: {
    removedFaces?: number;
    originalFaces?: number;
    remainingFaces?: number;
  };
}

/**
 * Remove furniture from a room scan
 */
export async function removeFurniture(
  meshUrl: string,
  options: {
    floorHeight?: number;
    aggressive?: boolean;
  } = {}
): Promise<MeshEditResult> {
  console.log('[MeshEditor] Removing furniture from:', meshUrl);
  
  const response = await fetch('/api/mesh-editor/remove-furniture', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      meshUrl,
      floorHeight: options.floorHeight ?? 0,
      aggressive: options.aggressive ?? false,
    }),
  });
  
  return response.json();
}

/**
 * Cut an opening in a wall (doorway, window, etc.)
 */
export async function cutOpening(
  meshUrl: string,
  openingType: 'door' | 'window' | 'arch' | 'box',
  position: [number, number, number],
  size: [number, number, number]
): Promise<MeshEditResult> {
  console.log(`[MeshEditor] Cutting ${openingType} at:`, position);
  
  const response = await fetch('/api/mesh-editor/cut-opening', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      meshUrl,
      openingType,
      position,
      size,
    }),
  });
  
  return response.json();
}

/**
 * Polygon point for measured hole cutting
 */
export interface PolygonPoint {
  x: number;
  y: number;
  z: number;
  normalX?: number;
  normalY?: number;
  normalZ?: number;
}

/**
 * Cut a polygon-shaped hole in a mesh using measured points
 * This allows for precise, calibrated hole cutting with any number of sides
 */
export async function cutPolygonHole(
  meshUrl: string,
  points: PolygonPoint[],
  options: {
    extrudeDepth?: number;  // How deep to extrude the cut (in mesh units)
    smoothEdges?: boolean;  // Whether to smooth the cut edges
    viewerScale?: number;   // Scale factor applied by the viewer (if mesh was scaled down)
    originalScanId?: string; // Original scan ID for texture lookup when editing already-edited meshes
  } = {}
): Promise<MeshEditResult> {
  console.log(`[MeshEditor] Cutting polygon hole with ${points.length} points`);
  console.log('[MeshEditor] Points:', points);
  console.log('[MeshEditor] Viewer scale:', options.viewerScale ?? 1);
  
  const response = await fetch('/api/mesh-editor/cut-polygon', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      meshUrl,
      points,
      extrudeDepth: options.extrudeDepth ?? 0.5,  // Default 0.5 mesh units
      smoothEdges: options.smoothEdges ?? true,
      viewerScale: options.viewerScale ?? 1,  // Scale factor applied by viewer
      originalScanId: options.originalScanId ?? null,  // For texture lookup on edited meshes
    }),
  });
  
  return response.json();
}

/**
 * Smooth mesh to reduce artifacts
 */
export async function smoothMesh(
  meshUrl: string,
  iterations: number = 3
): Promise<MeshEditResult> {
  console.log('[MeshEditor] Smoothing mesh:', meshUrl);
  
  const response = await fetch('/api/mesh-editor/smooth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ meshUrl, iterations }),
  });
  
  return response.json();
}

/**
 * Fill holes in mesh
 */
export async function fillHoles(meshUrl: string): Promise<MeshEditResult> {
  console.log('[MeshEditor] Filling holes in:', meshUrl);
  
  const response = await fetch('/api/mesh-editor/fill-holes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ meshUrl }),
  });
  
  return response.json();
}

/**
 * Segment mesh into surfaces
 */
export async function segmentMesh(meshUrl: string): Promise<{
  success: boolean;
  segments?: {
    floor_faces: number;
    ceiling_faces: number;
    wall_faces: number;
    other_faces: number;
    total_faces: number;
  };
  error?: string;
}> {
  console.log('[MeshEditor] Segmenting mesh:', meshUrl);
  
  const response = await fetch('/api/mesh-editor/segment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ meshUrl }),
  });
  
  return response.json();
}

// ============================================================================
// 3D Selection Tools (Client-Side)
// ============================================================================

export interface SelectionResult {
  type: 'face' | 'vertex' | 'object';
  indices: number[];
  worldPosition: THREE.Vector3;
  normal?: THREE.Vector3;
}

/**
 * Raycaster-based face selection
 */
export function selectFaceAtPoint(
  mesh: THREE.Mesh,
  camera: THREE.Camera,
  mousePosition: { x: number; y: number },
  containerSize: { width: number; height: number }
): SelectionResult | null {
  // Convert mouse position to normalized device coordinates
  const ndc = new THREE.Vector2(
    (mousePosition.x / containerSize.width) * 2 - 1,
    -(mousePosition.y / containerSize.height) * 2 + 1
  );
  
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(ndc, camera);
  
  const intersects = raycaster.intersectObject(mesh, true);
  
  if (intersects.length > 0) {
    const hit = intersects[0];
    
    return {
      type: 'face',
      indices: hit.faceIndex !== undefined ? [hit.faceIndex] : [],
      worldPosition: hit.point.clone(),
      normal: hit.face?.normal?.clone(),
    };
  }
  
  return null;
}

/**
 * Select all faces within a sphere radius
 */
export function selectFacesInRadius(
  mesh: THREE.Mesh,
  center: THREE.Vector3,
  radius: number
): number[] {
  const geometry = mesh.geometry;
  const positionAttr = geometry.attributes.position;
  const indexAttr = geometry.index;
  
  const selectedFaces: number[] = [];
  
  if (!indexAttr) {
    // Non-indexed geometry
    for (let i = 0; i < positionAttr.count; i += 3) {
      const v0 = new THREE.Vector3().fromBufferAttribute(positionAttr, i);
      const v1 = new THREE.Vector3().fromBufferAttribute(positionAttr, i + 1);
      const v2 = new THREE.Vector3().fromBufferAttribute(positionAttr, i + 2);
      
      // Transform to world space
      v0.applyMatrix4(mesh.matrixWorld);
      v1.applyMatrix4(mesh.matrixWorld);
      v2.applyMatrix4(mesh.matrixWorld);
      
      // Check if face center is within radius
      const faceCenter = new THREE.Vector3()
        .addVectors(v0, v1)
        .add(v2)
        .divideScalar(3);
      
      if (faceCenter.distanceTo(center) <= radius) {
        selectedFaces.push(i / 3);
      }
    }
  } else {
    // Indexed geometry
    const indices = indexAttr.array;
    for (let i = 0; i < indices.length; i += 3) {
      const v0 = new THREE.Vector3().fromBufferAttribute(positionAttr, indices[i]);
      const v1 = new THREE.Vector3().fromBufferAttribute(positionAttr, indices[i + 1]);
      const v2 = new THREE.Vector3().fromBufferAttribute(positionAttr, indices[i + 2]);
      
      v0.applyMatrix4(mesh.matrixWorld);
      v1.applyMatrix4(mesh.matrixWorld);
      v2.applyMatrix4(mesh.matrixWorld);
      
      const faceCenter = new THREE.Vector3()
        .addVectors(v0, v1)
        .add(v2)
        .divideScalar(3);
      
      if (faceCenter.distanceTo(center) <= radius) {
        selectedFaces.push(i / 3);
      }
    }
  }
  
  return selectedFaces;
}

/**
 * Select faces by height range (useful for selecting floor)
 */
export function selectFacesByHeight(
  mesh: THREE.Mesh,
  minHeight: number,
  maxHeight: number
): number[] {
  const geometry = mesh.geometry;
  const positionAttr = geometry.attributes.position;
  const indexAttr = geometry.index;
  
  const selectedFaces: number[] = [];
  
  const processTriangle = (i0: number, i1: number, i2: number, faceIdx: number) => {
    const v0 = new THREE.Vector3().fromBufferAttribute(positionAttr, i0);
    const v1 = new THREE.Vector3().fromBufferAttribute(positionAttr, i1);
    const v2 = new THREE.Vector3().fromBufferAttribute(positionAttr, i2);
    
    v0.applyMatrix4(mesh.matrixWorld);
    v1.applyMatrix4(mesh.matrixWorld);
    v2.applyMatrix4(mesh.matrixWorld);
    
    const avgHeight = (v0.y + v1.y + v2.y) / 3;
    
    if (avgHeight >= minHeight && avgHeight <= maxHeight) {
      selectedFaces.push(faceIdx);
    }
  };
  
  if (!indexAttr) {
    for (let i = 0; i < positionAttr.count; i += 3) {
      processTriangle(i, i + 1, i + 2, i / 3);
    }
  } else {
    const indices = indexAttr.array;
    for (let i = 0; i < indices.length; i += 3) {
      processTriangle(indices[i], indices[i + 1], indices[i + 2], i / 3);
    }
  }
  
  return selectedFaces;
}

/**
 * Select faces by normal direction (e.g., all upward-facing = floor)
 */
export function selectFacesByNormal(
  mesh: THREE.Mesh,
  targetNormal: THREE.Vector3,
  threshold: number = 0.7
): number[] {
  const geometry = mesh.geometry;
  
  // Compute face normals if not present
  geometry.computeVertexNormals();
  
  const positionAttr = geometry.attributes.position;
  const indexAttr = geometry.index;
  
  const selectedFaces: number[] = [];
  
  const computeFaceNormal = (v0: THREE.Vector3, v1: THREE.Vector3, v2: THREE.Vector3): THREE.Vector3 => {
    const edge1 = new THREE.Vector3().subVectors(v1, v0);
    const edge2 = new THREE.Vector3().subVectors(v2, v0);
    return new THREE.Vector3().crossVectors(edge1, edge2).normalize();
  };
  
  const processTriangle = (i0: number, i1: number, i2: number, faceIdx: number) => {
    const v0 = new THREE.Vector3().fromBufferAttribute(positionAttr, i0);
    const v1 = new THREE.Vector3().fromBufferAttribute(positionAttr, i1);
    const v2 = new THREE.Vector3().fromBufferAttribute(positionAttr, i2);
    
    const normal = computeFaceNormal(v0, v1, v2);
    
    // Transform normal to world space
    normal.transformDirection(mesh.matrixWorld);
    
    if (normal.dot(targetNormal) >= threshold) {
      selectedFaces.push(faceIdx);
    }
  };
  
  if (!indexAttr) {
    for (let i = 0; i < positionAttr.count; i += 3) {
      processTriangle(i, i + 1, i + 2, i / 3);
    }
  } else {
    const indices = indexAttr.array;
    for (let i = 0; i < indices.length; i += 3) {
      processTriangle(indices[i], indices[i + 1], indices[i + 2], i / 3);
    }
  }
  
  return selectedFaces;
}

// ============================================================================
// Visualization Helpers
// ============================================================================

/**
 * Create a highlight material for selected faces
 */
export function createSelectionMaterial(color: number = 0x00ff00): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.5,
    side: THREE.DoubleSide,
    depthTest: false,
  });
}

/**
 * Create a mesh showing only the selected faces (for preview)
 */
export function createSelectionPreview(
  sourceMesh: THREE.Mesh,
  faceIndices: number[],
  color: number = 0x00ff00
): THREE.Mesh {
  const geometry = sourceMesh.geometry.clone();
  const positionAttr = geometry.attributes.position;
  const indexAttr = geometry.index;
  
  // Create new geometry with only selected faces
  const newPositions: number[] = [];
  
  if (!indexAttr) {
    for (const faceIdx of faceIndices) {
      const baseIdx = faceIdx * 3;
      for (let i = 0; i < 3; i++) {
        const idx = baseIdx + i;
        newPositions.push(
          positionAttr.getX(idx),
          positionAttr.getY(idx),
          positionAttr.getZ(idx)
        );
      }
    }
  } else {
    const indices = indexAttr.array;
    for (const faceIdx of faceIndices) {
      const baseIdx = faceIdx * 3;
      for (let i = 0; i < 3; i++) {
        const vertIdx = indices[baseIdx + i];
        newPositions.push(
          positionAttr.getX(vertIdx),
          positionAttr.getY(vertIdx),
          positionAttr.getZ(vertIdx)
        );
      }
    }
  }
  
  const newGeometry = new THREE.BufferGeometry();
  newGeometry.setAttribute('position', new THREE.Float32BufferAttribute(newPositions, 3));
  newGeometry.computeVertexNormals();
  
  const material = createSelectionMaterial(color);
  const previewMesh = new THREE.Mesh(newGeometry, material);
  
  // Copy transforms from source
  previewMesh.position.copy(sourceMesh.position);
  previewMesh.rotation.copy(sourceMesh.rotation);
  previewMesh.scale.copy(sourceMesh.scale);
  
  return previewMesh;
}

/**
 * Create a wireframe box for CSG operation preview
 */
export function createBoxPreview(
  center: THREE.Vector3,
  size: THREE.Vector3,
  color: number = 0xff0000
): THREE.LineSegments {
  const geometry = new THREE.BoxGeometry(size.x, size.y, size.z);
  const edges = new THREE.EdgesGeometry(geometry);
  const material = new THREE.LineBasicMaterial({ color, linewidth: 2 });
  const wireframe = new THREE.LineSegments(edges, material);
  
  wireframe.position.copy(center);
  
  return wireframe;
}

// ============================================================================
// Local Mesh Editing (Client-Side, for small operations)
// ============================================================================

/**
 * Delete selected faces from mesh (client-side)
 * For small selections, this is faster than server round-trip
 */
export function deleteSelectedFaces(
  mesh: THREE.Mesh,
  faceIndicesToDelete: number[]
): THREE.BufferGeometry {
  const geometry = mesh.geometry;
  const positionAttr = geometry.attributes.position;
  const normalAttr = geometry.attributes.normal;
  const uvAttr = geometry.attributes.uv;
  const indexAttr = geometry.index;
  
  const deleteSet = new Set(faceIndicesToDelete);
  
  const newPositions: number[] = [];
  const newNormals: number[] = [];
  const newUVs: number[] = [];
  
  const processTriangle = (i0: number, i1: number, i2: number, faceIdx: number) => {
    if (deleteSet.has(faceIdx)) return;
    
    for (const idx of [i0, i1, i2]) {
      newPositions.push(
        positionAttr.getX(idx),
        positionAttr.getY(idx),
        positionAttr.getZ(idx)
      );
      
      if (normalAttr) {
        newNormals.push(
          normalAttr.getX(idx),
          normalAttr.getY(idx),
          normalAttr.getZ(idx)
        );
      }
      
      if (uvAttr) {
        newUVs.push(uvAttr.getX(idx), uvAttr.getY(idx));
      }
    }
  };
  
  if (!indexAttr) {
    for (let i = 0; i < positionAttr.count; i += 3) {
      processTriangle(i, i + 1, i + 2, i / 3);
    }
  } else {
    const indices = indexAttr.array;
    for (let i = 0; i < indices.length; i += 3) {
      processTriangle(indices[i], indices[i + 1], indices[i + 2], i / 3);
    }
  }
  
  const newGeometry = new THREE.BufferGeometry();
  newGeometry.setAttribute('position', new THREE.Float32BufferAttribute(newPositions, 3));
  
  if (newNormals.length > 0) {
    newGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(newNormals, 3));
  } else {
    newGeometry.computeVertexNormals();
  }
  
  if (newUVs.length > 0) {
    newGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(newUVs, 2));
  }
  
  return newGeometry;
}
// ============================================================================
// Meshy AI Retexturing API
// ============================================================================

/**
 * Meshy retexture task creation response
 */
export interface MeshyRetextureResponse {
  success: boolean;
  taskId?: string;
  jobId?: string;
  error?: string;
  message?: string;
}

/**
 * Meshy retexture status response
 */
export interface MeshyRetextureStatus {
  success: boolean;
  jobId: string;
  taskId: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'EXPIRED';
  progress: number;
  originalMeshUrl?: string;
  textPrompt?: string;
  createdAt?: string;
  modelUrls?: {
    glb?: string;
    fbx?: string;
    obj?: string;
    usdz?: string;
  };
  thumbnailUrl?: string;
  textureUrls?: {
    baseColor?: string;
    metallic?: string;
    roughness?: string;
    normal?: string;
  };
  error?: string;
}

/**
 * Meshy download result
 */
export interface MeshyDownloadResult {
  success: boolean;
  localUrl?: string;
  thumbnailUrl?: string | null;
  textureUrls?: Record<string, string>;
  format?: string;
  fileSize?: number;
  error?: string;
}

/**
 * Meshy history item
 */
export interface MeshyHistoryItem {
  filename: string;
  url: string;
  thumbnailUrl: string | null;
  fileSize: number;
  createdAt: string;
}

/**
 * Create a Meshy AI retexturing task
 * 
 * @param meshUrl - Path to the mesh file (local or API path)
 * @param textPrompt - Text description of desired texture (e.g., "polished oak hardwood flooring")
 * @param options - Optional parameters
 * @returns Task creation response with jobId for polling
 */
export async function createMeshyRetextureTask(
  meshUrl: string,
  textPrompt: string,
  options: {
    imagePrompt?: string;
    artStyle?: 'realistic' | 'cartoon' | 'low-poly' | 'sculpture' | 'pbr';
    enablePBR?: boolean;
    resolution?: '1024' | '2048' | '4096';
    negativePrompt?: string;
    surfaceType?: 'flooring' | 'walls' | 'countertops'; // Which surface to apply texture to
    enableOriginalUV?: boolean; // Set to false for preprocessed meshes to use Meshy's clean UVs
  } = {}
): Promise<MeshyRetextureResponse> {
  console.log('[MeshyRetexture] Creating task:', { meshUrl, textPrompt, options });
  
  const response = await fetch('/api/meshy/retexture', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      meshUrl,
      textPrompt,
      imagePrompt: options.imagePrompt,
      artStyle: options.artStyle ?? 'realistic',
      enablePBR: options.enablePBR ?? true,
      resolution: options.resolution ?? '2048',
      negativePrompt: options.negativePrompt,
      surfaceType: options.surfaceType ?? 'flooring', // Default to flooring
      enableOriginalUV: options.enableOriginalUV ?? false, // Default to false for clean UVs
    }),
  });
  
  return response.json();
}

/**
 * Poll for Meshy retexture task status
 * 
 * @param jobId - The local job ID from createMeshyRetextureTask
 */
export async function getMeshyRetextureStatus(jobId: string): Promise<MeshyRetextureStatus> {
  const response = await fetch(`/api/meshy/status/${jobId}`);
  return response.json();
}

/**
 * Download the completed retextured model
 * 
 * @param jobId - The local job ID
 * @param format - Output format (glb, fbx, obj, usdz)
 */
export async function downloadMeshyModel(
  jobId: string,
  format: 'glb' | 'fbx' | 'obj' | 'usdz' = 'glb'
): Promise<MeshyDownloadResult> {
  const response = await fetch(`/api/meshy/download/${jobId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ format }),
  });
  
  return response.json();
}

/**
 * One-shot retexture: Create task, wait for completion, and download
 * 
 * WARNING: This is a long-running call (1-3 minutes typically)
 * 
 * @param meshUrl - Path to the mesh file
 * @param textPrompt - Description of the desired texture
 * @param options - Optional parameters
 */
export async function retextureAndWait(
  meshUrl: string,
  textPrompt: string,
  options: {
    imagePrompt?: string;
    artStyle?: 'realistic' | 'cartoon' | 'low-poly' | 'sculpture' | 'pbr';
    enablePBR?: boolean;
    resolution?: '1024' | '2048' | '4096';
    negativePrompt?: string;
    maxWaitSeconds?: number;
    onProgress?: (status: string, progress: number) => void;
  } = {}
): Promise<{
  success: boolean;
  localUrl?: string;
  modelUrls?: Record<string, string>;
  textureUrls?: Record<string, string>;
  thumbnailUrl?: string;
  processingTime?: number;
  error?: string;
}> {
  console.log('[MeshyRetexture] Starting retexture-and-wait:', { meshUrl, textPrompt });
  
  options.onProgress?.('Creating task...', 0);
  
  const response = await fetch('/api/meshy/retexture-and-wait', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      meshUrl,
      textPrompt,
      imagePrompt: options.imagePrompt,
      artStyle: options.artStyle ?? 'realistic',
      enablePBR: options.enablePBR ?? true,
      resolution: options.resolution ?? '2048',
      negativePrompt: options.negativePrompt,
      maxWaitSeconds: options.maxWaitSeconds ?? 180,
    }),
  });
  
  return response.json();
}

/**
 * Poll for retexture completion with progress callback
 * 
 * @param jobId - Job ID from createMeshyRetextureTask
 * @param onProgress - Callback for progress updates
 * @param pollInterval - How often to poll (ms)
 * @param maxWait - Maximum wait time (ms)
 */
export async function pollMeshyRetextureUntilDone(
  jobId: string,
  onProgress?: (status: MeshyRetextureStatus) => void,
  pollInterval: number = 5000,
  maxWait: number = 300000 // 5 minutes
): Promise<MeshyRetextureStatus> {
  const startTime = Date.now();
  
  while (Date.now() - startTime < maxWait) {
    const status = await getMeshyRetextureStatus(jobId);
    
    onProgress?.(status);
    
    if (status.status === 'SUCCEEDED' || status.status === 'FAILED') {
      return status;
    }
    
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }
  
  throw new Error('Retexture task timed out');
}

/**
 * Get list of previously retextured meshes
 */
export async function getMeshyHistory(): Promise<{
  success: boolean;
  meshes: MeshyHistoryItem[];
  count: number;
}> {
  const response = await fetch('/api/meshy/history');
  return response.json();
}

/**
 * Get list of active retexture tasks
 */
export async function getActiveMeshyTasks(): Promise<{
  success: boolean;
  tasks: Array<{
    jobId: string;
    taskId: string;
    meshUrl: string;
    textPrompt: string;
    status: string;
    createdAt: string;
  }>;
  count: number;
}> {
  const response = await fetch('/api/meshy/tasks');
  return response.json();
}

/**
 * Cancel/remove a retexture task
 */
export async function cancelMeshyTask(jobId: string): Promise<{ success: boolean; message?: string; error?: string }> {
  const response = await fetch(`/api/meshy/tasks/${jobId}`, { method: 'DELETE' });
  return response.json();
}