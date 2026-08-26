/**
 * Face-Based Renovation Service
 * 
 * Uses GEOMETRY-BASED floor detection (normals + Y position) for reliable results.
 * Vision mask is only used as a secondary filter when it's reasonable.
 * 
 * Floor detection criteria:
 * 1. Face normal points upward (Y component > 0.7)
 * 2. Face is near the bottom of the mesh (lowest 15% of Y range)
 * 3. Optionally filtered by AI vision mask if it's not degenerate
 */

import * as THREE from 'three';

// Threshold for considering a face as "upward facing" (floor)
// 15 degrees from vertical = cos(15°) ≈ 0.966
const FLOOR_NORMAL_Y_THRESHOLD = 0.95;  // Normal Y must be > this (matches meshSegmentation's 15°)
const FLOOR_HEIGHT_PERCENTAGE = 0.20;   // Bottom 20% of mesh height

export interface FaceRenovationResult {
  success: boolean;
  floorFaceCount: number;
  totalFaceCount: number;
  restore: () => void;
  error?: string;
}

/**
 * Apply floor texture to specific faces based on vision mask.
 * Creates a multi-material mesh where floor faces have the new texture.
 */
export async function applyFloorTextureByMask(
  mesh: THREE.Mesh,
  floorTextureUrl: string,
  maskLookup: boolean[][],
  camera: THREE.Camera,
  onProgress?: (stage: string, progress: number) => void
): Promise<FaceRenovationResult> {
  console.log('[FaceRenovation] Starting face-based floor renovation...');
  
  try {
    const geometry = mesh.geometry as THREE.BufferGeometry;
    const position = geometry.getAttribute('position');
    
    if (!position) {
      throw new Error('Mesh has no position attribute');
    }
    
    // Save original state for restoration
    const originalMaterial = mesh.material;
    const originalGroups = [...geometry.groups];
    
    onProgress?.('Analyzing faces...', 0.1);
    
    // Get face count
    const isIndexed = geometry.index !== null;
    const faceCount = isIndexed 
      ? (geometry.index!.count / 3) 
      : (position.count / 3);
    
    console.log('[FaceRenovation] Total faces:', faceCount);
    console.log('[FaceRenovation] Mask resolution:', maskLookup.length, 'x', maskLookup[0]?.length || 0);
    
    // Debug: Count how many true values in mask
    let trueCount = 0;
    let totalCount = 0;
    for (const row of maskLookup) {
      for (const val of row) {
        totalCount++;
        if (val) trueCount++;
      }
    }
    console.log('[FaceRenovation] Mask stats: true =', trueCount, '/', totalCount, '=', (trueCount / totalCount * 100).toFixed(1) + '%');
    
    // Check if mask is degenerate (>80% or <5% floor = unusable)
    const maskFloorPercentage = trueCount / totalCount;
    const maskUsable = maskFloorPercentage >= 0.02 && maskFloorPercentage <= 0.90;
    console.log('[FaceRenovation] Mask usable:', maskUsable, '(floor %:', (maskFloorPercentage * 100).toFixed(1) + ')');
    
    if (!maskUsable) {
      console.warn('[FaceRenovation] Mask is degenerate, cannot apply floor texture');
      return {
        success: false,
        floorFaceCount: 0,
        totalFaceCount: faceCount,
        restore: () => {},
        error: 'Mask is degenerate (too much or too little floor detected)',
      };
    }
    
    onProgress?.('Projecting faces to AI mask...', 0.2);
    
    // ========================================================================
    // MASK-BASED FLOOR DETECTION (Trust the AI!)
    // Project each face center to screen coordinates and check the mask.
    // Only require upward-facing normal, NO height filter (mesh transforms vary).
    // ========================================================================
    
    // Classify faces using mask projection + normal check
    const floorFaceIndices: number[] = [];
    const nonFloorFaceIndices: number[] = [];
    
    // Debug counters
    let normalPassCount = 0;
    let projectedInBounds = 0;
    let maskSaysFloorCount = 0;
    
    for (let i = 0; i < faceCount; i++) {
      // Get face vertices
      let i0: number, i1: number, i2: number;
      
      if (isIndexed) {
        const index = geometry.index!;
        i0 = index.getX(i * 3);
        i1 = index.getX(i * 3 + 1);
        i2 = index.getX(i * 3 + 2);
      } else {
        i0 = i * 3;
        i1 = i * 3 + 1;
        i2 = i * 3 + 2;
      }
      
      // Get face vertices in local space
      const v0 = new THREE.Vector3().fromBufferAttribute(position, i0);
      const v1 = new THREE.Vector3().fromBufferAttribute(position, i1);
      const v2 = new THREE.Vector3().fromBufferAttribute(position, i2);
      
      // Compute face normal (cross product of edges)
      const edge1 = new THREE.Vector3().subVectors(v1, v0);
      const edge2 = new THREE.Vector3().subVectors(v2, v0);
      const normal = new THREE.Vector3().crossVectors(edge1, edge2).normalize();
      
      // Transform normal to world space (only rotation, not translation)
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
      normal.applyMatrix3(normalMatrix).normalize();
      
      // Check if face points upward (floor must be horizontal)
      // Use a looser threshold (0.7 instead of 0.95) to catch more floor faces
      const isUpwardFacing = normal.y > 0.7;
      if (isUpwardFacing) normalPassCount++;
      
      // Get face center in world space
      const center = new THREE.Vector3()
        .add(v0).add(v1).add(v2)
        .divideScalar(3)
        .applyMatrix4(mesh.matrixWorld);
      
      // Project to screen and check mask
      const projected = center.clone().project(camera);
      const u = (projected.x + 1) / 2;
      const v = 1 - (projected.y + 1) / 2;
      
      let isFinalFloor = false;
      
      // Check if within screen bounds and in front of camera
      if (u >= 0 && u <= 1 && v >= 0 && v <= 1 && projected.z > 0 && projected.z < 1) {
        projectedInBounds++;
        
        const maskX = Math.floor(u * (maskLookup[0]?.length || 1));
        const maskY = Math.floor(v * maskLookup.length);
        const maskSaysFloor = maskLookup[maskY]?.[maskX] ?? false;
        
        if (maskSaysFloor) {
          maskSaysFloorCount++;
          // Face is floor if mask says so AND it's upward-facing
          if (isUpwardFacing) {
            isFinalFloor = true;
          }
        }
      }
      
      if (isFinalFloor) {
        floorFaceIndices.push(i);
      } else {
        nonFloorFaceIndices.push(i);
      }
    }
    
    console.log('[FaceRenovation] Mask projection stats:');
    console.log('  Upward-facing (normal.y > 0.7):', normalPassCount);
    console.log('  Projected in bounds:', projectedInBounds);
    console.log('  Mask says floor:', maskSaysFloorCount);
    console.log('[FaceRenovation] Final floor faces:', floorFaceIndices.length);
    console.log('[FaceRenovation] Non-floor faces:', nonFloorFaceIndices.length);
    
    if (floorFaceIndices.length === 0) {
      console.warn('[FaceRenovation] No floor faces detected by mask!');
      return {
        success: false,
        floorFaceCount: 0,
        totalFaceCount: faceCount,
        restore: () => {},
        error: 'No floor faces detected in mask',
      };
    }
    
    onProgress?.('Loading floor texture...', 0.4);
    
    // Load the floor texture
    const textureLoader = new THREE.TextureLoader();
    const floorTexture = await new Promise<THREE.Texture>((resolve, reject) => {
      textureLoader.load(
        floorTextureUrl,
        (texture) => {
          texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
          texture.repeat.set(4, 4);  // Tile the texture
          resolve(texture);
        },
        undefined,
        reject
      );
    });
    
    onProgress?.('Creating materials...', 0.6);
    
    // Get original material(s)
    const originalMaterials = Array.isArray(originalMaterial) 
      ? originalMaterial 
      : [originalMaterial];
    
    // Create floor material (copy properties from original if possible)
    const origMat = originalMaterials[0] as THREE.MeshStandardMaterial | THREE.MeshPhongMaterial;
    
    const floorMaterial = new THREE.MeshStandardMaterial({
      map: floorTexture,
      roughness: 0.4,
      metalness: 0.0,
    });
    
    onProgress?.('Rebuilding geometry...', 0.7);
    
    // We need to rebuild the geometry with proper face groups
    // This requires reordering the indices/vertices
    
    if (isIndexed) {
      // Indexed geometry - reorder indices
      const oldIndex = geometry.index!;
      const newIndexArray = new Uint32Array(oldIndex.count);
      
      let writePos = 0;
      
      // First, write non-floor faces
      const nonFloorStart = 0;
      for (const faceIdx of nonFloorFaceIndices) {
        newIndexArray[writePos++] = oldIndex.getX(faceIdx * 3);
        newIndexArray[writePos++] = oldIndex.getX(faceIdx * 3 + 1);
        newIndexArray[writePos++] = oldIndex.getX(faceIdx * 3 + 2);
      }
      const nonFloorEnd = writePos;
      
      // Then, write floor faces
      const floorStart = writePos;
      for (const faceIdx of floorFaceIndices) {
        newIndexArray[writePos++] = oldIndex.getX(faceIdx * 3);
        newIndexArray[writePos++] = oldIndex.getX(faceIdx * 3 + 1);
        newIndexArray[writePos++] = oldIndex.getX(faceIdx * 3 + 2);
      }
      const floorEnd = writePos;
      
      // Update index buffer
      geometry.setIndex(new THREE.BufferAttribute(newIndexArray, 1));
      
      // Clear existing groups and add new ones
      geometry.clearGroups();
      geometry.addGroup(nonFloorStart, nonFloorEnd - nonFloorStart, 0);  // Original material
      geometry.addGroup(floorStart, floorEnd - floorStart, 1);  // Floor material
      
      console.log('[FaceRenovation] Groups: non-floor', nonFloorStart, '-', nonFloorEnd, 
                  ', floor', floorStart, '-', floorEnd);
    } else {
      // Non-indexed geometry - create an index buffer to enable multi-material
      console.log('[FaceRenovation] Non-indexed geometry - creating index buffer for multi-material');
      
      // For non-indexed geometry, each face uses 3 consecutive vertices
      // We need to create an index array that reorders faces: non-floor first, then floor
      const totalVertices = faceCount * 3;
      const newIndexArray = new Uint32Array(totalVertices);
      
      let writePos = 0;
      
      // First, add non-floor faces
      const nonFloorStart = 0;
      for (const faceIdx of nonFloorFaceIndices) {
        newIndexArray[writePos++] = faceIdx * 3;
        newIndexArray[writePos++] = faceIdx * 3 + 1;
        newIndexArray[writePos++] = faceIdx * 3 + 2;
      }
      const nonFloorEnd = writePos;
      
      // Then, add floor faces
      const floorStart = writePos;
      for (const faceIdx of floorFaceIndices) {
        newIndexArray[writePos++] = faceIdx * 3;
        newIndexArray[writePos++] = faceIdx * 3 + 1;
        newIndexArray[writePos++] = faceIdx * 3 + 2;
      }
      const floorEnd = writePos;
      
      // Set the index buffer
      geometry.setIndex(new THREE.BufferAttribute(newIndexArray, 1));
      
      // Set up groups
      geometry.clearGroups();
      geometry.addGroup(nonFloorStart, nonFloorEnd - nonFloorStart, 0);  // Original material
      geometry.addGroup(floorStart, floorEnd - floorStart, 1);  // Floor material
      
      console.log('[FaceRenovation] Created index buffer. Groups: non-floor', nonFloorStart, '-', nonFloorEnd, 
                  ', floor', floorStart, '-', floorEnd);
    }
    
    onProgress?.('Applying materials...', 0.9);
    
    // Set multi-material
    mesh.material = [origMat, floorMaterial];
    
    console.log('[FaceRenovation] ✅ Floor texture applied to', floorFaceIndices.length, 'faces');
    
    onProgress?.('Complete!', 1.0);
    
    return {
      success: true,
      floorFaceCount: floorFaceIndices.length,
      totalFaceCount: faceCount,
      restore: () => {
        // Restore original material and groups
        mesh.material = originalMaterial;
        geometry.clearGroups();
        for (const group of originalGroups) {
          geometry.addGroup(group.start, group.count, group.materialIndex);
        }
        floorTexture.dispose();
        floorMaterial.dispose();
        console.log('[FaceRenovation] Restored original material');
      },
    };
    
  } catch (error) {
    console.error('[FaceRenovation] Error:', error);
    return {
      success: false,
      floorFaceCount: 0,
      totalFaceCount: 0,
      restore: () => {},
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Simpler approach: Apply floor texture based on Y-height and normal direction only.
 * No vision mask needed - uses geometry analysis.
 */
export async function applyFloorTextureByGeometry(
  mesh: THREE.Mesh,
  floorTextureUrl: string,
  floorYThreshold: number = 0.15,  // Fraction of mesh height to consider as floor
  normalThreshold: number = 0.7,   // How upward-facing the normal must be
  onProgress?: (stage: string, progress: number) => void
): Promise<FaceRenovationResult> {
  console.log('[FaceRenovation] Starting geometry-based floor renovation...');
  
  try {
    const geometry = mesh.geometry as THREE.BufferGeometry;
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    
    if (!position || !normal) {
      throw new Error('Mesh missing position or normal attributes');
    }
    
    // Save original state
    const originalMaterial = mesh.material;
    const originalGroups = [...geometry.groups];
    
    onProgress?.('Analyzing mesh bounds...', 0.1);
    
    // Compute bounding box
    geometry.computeBoundingBox();
    const bbox = geometry.boundingBox!;
    const meshHeight = bbox.max.y - bbox.min.y;
    const floorMaxY = bbox.min.y + (meshHeight * floorYThreshold);
    
    console.log('[FaceRenovation] Mesh Y range:', bbox.min.y.toFixed(2), 'to', bbox.max.y.toFixed(2));
    console.log('[FaceRenovation] Floor Y threshold:', floorMaxY.toFixed(2));
    
    onProgress?.('Classifying faces...', 0.2);
    
    // Classify faces
    const isIndexed = geometry.index !== null;
    const faceCount = isIndexed 
      ? (geometry.index!.count / 3) 
      : (position.count / 3);
    
    const floorFaceIndices: number[] = [];
    const nonFloorFaceIndices: number[] = [];
    
    for (let i = 0; i < faceCount; i++) {
      let i0: number, i1: number, i2: number;
      
      if (isIndexed) {
        const index = geometry.index!;
        i0 = index.getX(i * 3);
        i1 = index.getX(i * 3 + 1);
        i2 = index.getX(i * 3 + 2);
      } else {
        i0 = i * 3;
        i1 = i * 3 + 1;
        i2 = i * 3 + 2;
      }
      
      // Get face center Y
      const y0 = position.getY(i0);
      const y1 = position.getY(i1);
      const y2 = position.getY(i2);
      const centerY = (y0 + y1 + y2) / 3;
      
      // Get average normal Y component
      const ny0 = normal.getY(i0);
      const ny1 = normal.getY(i1);
      const ny2 = normal.getY(i2);
      const avgNormalY = (ny0 + ny1 + ny2) / 3;
      
      // Floor criteria: low Y position AND upward-facing normal
      const isLowEnough = centerY < floorMaxY;
      const isFacingUp = avgNormalY > normalThreshold;
      
      if (isLowEnough && isFacingUp) {
        floorFaceIndices.push(i);
      } else {
        nonFloorFaceIndices.push(i);
      }
    }
    
    console.log('[FaceRenovation] Floor faces (by geometry):', floorFaceIndices.length);
    console.log('[FaceRenovation] Non-floor faces:', nonFloorFaceIndices.length);
    
    if (floorFaceIndices.length === 0) {
      return {
        success: false,
        floorFaceCount: 0,
        totalFaceCount: faceCount,
        restore: () => {},
        error: 'No floor faces detected by geometry analysis',
      };
    }
    
    onProgress?.('Loading floor texture...', 0.4);
    
    // Load floor texture
    const textureLoader = new THREE.TextureLoader();
    const floorTexture = await new Promise<THREE.Texture>((resolve, reject) => {
      textureLoader.load(
        floorTextureUrl,
        (texture) => {
          texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
          texture.repeat.set(8, 8);
          resolve(texture);
        },
        undefined,
        reject
      );
    });
    
    onProgress?.('Rebuilding geometry...', 0.6);
    
    // Rebuild index buffer with face groups
    if (isIndexed) {
      const oldIndex = geometry.index!;
      const newIndexArray = new Uint32Array(oldIndex.count);
      
      let writePos = 0;
      
      // Non-floor faces first
      const nonFloorStart = 0;
      for (const faceIdx of nonFloorFaceIndices) {
        newIndexArray[writePos++] = oldIndex.getX(faceIdx * 3);
        newIndexArray[writePos++] = oldIndex.getX(faceIdx * 3 + 1);
        newIndexArray[writePos++] = oldIndex.getX(faceIdx * 3 + 2);
      }
      const nonFloorEnd = writePos;
      
      // Floor faces
      const floorStart = writePos;
      for (const faceIdx of floorFaceIndices) {
        newIndexArray[writePos++] = oldIndex.getX(faceIdx * 3);
        newIndexArray[writePos++] = oldIndex.getX(faceIdx * 3 + 1);
        newIndexArray[writePos++] = oldIndex.getX(faceIdx * 3 + 2);
      }
      const floorEnd = writePos;
      
      geometry.setIndex(new THREE.BufferAttribute(newIndexArray, 1));
      
      geometry.clearGroups();
      geometry.addGroup(nonFloorStart, nonFloorEnd - nonFloorStart, 0);
      geometry.addGroup(floorStart, floorEnd - floorStart, 1);
    }
    
    onProgress?.('Applying materials...', 0.8);
    
    // Get original material
    const originalMaterials = Array.isArray(originalMaterial) 
      ? originalMaterial 
      : [originalMaterial];
    
    const origMat = originalMaterials[0];
    
    // Create floor material
    const floorMaterial = new THREE.MeshStandardMaterial({
      map: floorTexture,
      roughness: 0.4,
      metalness: 0.0,
    });
    
    mesh.material = [origMat, floorMaterial];
    
    console.log('[FaceRenovation] ✅ Applied floor texture to', floorFaceIndices.length, 'faces');
    
    onProgress?.('Complete!', 1.0);
    
    return {
      success: true,
      floorFaceCount: floorFaceIndices.length,
      totalFaceCount: faceCount,
      restore: () => {
        mesh.material = originalMaterial;
        geometry.clearGroups();
        for (const group of originalGroups) {
          geometry.addGroup(group.start, group.count, group.materialIndex);
        }
        floorTexture.dispose();
        floorMaterial.dispose();
      },
    };
    
  } catch (error) {
    console.error('[FaceRenovation] Error:', error);
    return {
      success: false,
      floorFaceCount: 0,
      totalFaceCount: 0,
      restore: () => {},
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Apply floor texture to specific faces identified by mesh segmentation.
 * This is simpler and more reliable than mask-based approaches.
 */
export async function applyFloorTextureToSegmentedFaces(
  mesh: THREE.Mesh,
  floorTextureUrl: string,
  floorFaceIndices: Set<number>,
  onProgress?: (stage: string, progress: number) => void
): Promise<FaceRenovationResult> {
  console.log('[FaceRenovation] Applying texture to segmented floor faces...');
  console.log('[FaceRenovation] Floor faces from segmentation:', floorFaceIndices.size);
  
  try {
    const geometry = mesh.geometry as THREE.BufferGeometry;
    const position = geometry.getAttribute('position');
    
    if (!position) {
      throw new Error('Mesh has no position attribute');
    }
    
    // Save original state
    const originalMaterial = mesh.material;
    const originalGroups = [...geometry.groups];
    
    const isIndexed = geometry.index !== null;
    const faceCount = isIndexed ? (geometry.index!.count / 3) : (position.count / 3);
    
    if (floorFaceIndices.size === 0) {
      return {
        success: false,
        floorFaceCount: 0,
        totalFaceCount: faceCount,
        restore: () => {},
        error: 'No floor faces provided from segmentation',
      };
    }
    
    onProgress?.('Loading floor texture...', 0.3);
    
    // Load the floor texture
    const textureLoader = new THREE.TextureLoader();
    const floorTexture = await new Promise<THREE.Texture>((resolve, reject) => {
      textureLoader.load(
        floorTextureUrl,
        (texture) => {
          texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
          texture.repeat.set(4, 4);
          resolve(texture);
        },
        undefined,
        reject
      );
    });
    
    onProgress?.('Creating materials...', 0.5);
    
    // Get original material
    let originalMat: THREE.Material;
    if (Array.isArray(originalMaterial)) {
      originalMat = originalMaterial[0] || new THREE.MeshStandardMaterial();
    } else {
      originalMat = originalMaterial;
    }
    
    // Clone for non-floor faces
    const nonFloorMaterial = originalMat.clone();
    
    // Create floor material with new texture
    const floorMaterial = new THREE.MeshStandardMaterial({
      map: floorTexture,
      roughness: 0.8,
      metalness: 0.1,
    });
    
    onProgress?.('Rearranging geometry...', 0.7);
    
    // Create arrays for non-floor and floor face indices
    const nonFloorFaceIndices: number[] = [];
    for (let i = 0; i < faceCount; i++) {
      if (!floorFaceIndices.has(i)) {
        nonFloorFaceIndices.push(i);
      }
    }
    
    const floorFaceArray = Array.from(floorFaceIndices);
    
    console.log('[FaceRenovation] Non-floor faces:', nonFloorFaceIndices.length);
    console.log('[FaceRenovation] Floor faces:', floorFaceArray.length);
    
    // Rearrange geometry to group faces by material
    if (isIndexed) {
      const index = geometry.index!;
      const newIndexArray = new Uint32Array(index.count);
      let writePos = 0;
      
      // Non-floor faces first
      const nonFloorStart = 0;
      for (const faceIdx of nonFloorFaceIndices) {
        newIndexArray[writePos++] = index.getX(faceIdx * 3);
        newIndexArray[writePos++] = index.getX(faceIdx * 3 + 1);
        newIndexArray[writePos++] = index.getX(faceIdx * 3 + 2);
      }
      const nonFloorEnd = writePos;
      
      // Floor faces second
      const floorStart = writePos;
      for (const faceIdx of floorFaceArray) {
        newIndexArray[writePos++] = index.getX(faceIdx * 3);
        newIndexArray[writePos++] = index.getX(faceIdx * 3 + 1);
        newIndexArray[writePos++] = index.getX(faceIdx * 3 + 2);
      }
      const floorEnd = writePos;
      
      geometry.setIndex(new THREE.BufferAttribute(newIndexArray, 1));
      geometry.clearGroups();
      geometry.addGroup(nonFloorStart, nonFloorEnd - nonFloorStart, 0);
      geometry.addGroup(floorStart, floorEnd - floorStart, 1);
      
      console.log('[FaceRenovation] Groups: non-floor', nonFloorStart, '-', nonFloorEnd, ', floor', floorStart, '-', floorEnd);
    } else {
      // Non-indexed geometry - create index
      const totalVertices = faceCount * 3;
      const newIndexArray = new Uint32Array(totalVertices);
      let writePos = 0;
      
      // Non-floor first
      const nonFloorStart = 0;
      for (const faceIdx of nonFloorFaceIndices) {
        newIndexArray[writePos++] = faceIdx * 3;
        newIndexArray[writePos++] = faceIdx * 3 + 1;
        newIndexArray[writePos++] = faceIdx * 3 + 2;
      }
      const nonFloorEnd = writePos;
      
      // Floor second
      const floorStart = writePos;
      for (const faceIdx of floorFaceArray) {
        newIndexArray[writePos++] = faceIdx * 3;
        newIndexArray[writePos++] = faceIdx * 3 + 1;
        newIndexArray[writePos++] = faceIdx * 3 + 2;
      }
      const floorEnd = writePos;
      
      geometry.setIndex(new THREE.BufferAttribute(newIndexArray, 1));
      geometry.clearGroups();
      geometry.addGroup(nonFloorStart, nonFloorEnd - nonFloorStart, 0);
      geometry.addGroup(floorStart, floorEnd - floorStart, 1);
      
      console.log('[FaceRenovation] Created index. Groups: non-floor', nonFloorStart, '-', nonFloorEnd, ', floor', floorStart, '-', floorEnd);
    }
    
    // Apply multi-material
    mesh.material = [nonFloorMaterial, floorMaterial];
    
    onProgress?.('Complete!', 1);
    console.log('[FaceRenovation] ✅ Segmented floor texture applied!');
    
    return {
      success: true,
      floorFaceCount: floorFaceArray.length,
      totalFaceCount: faceCount,
      restore: () => {
        mesh.material = originalMaterial;
        geometry.clearGroups();
        geometry.groups.push(...originalGroups);
        if (originalGroups.length === 0 && geometry.index) {
          geometry.addGroup(0, geometry.index.count, 0);
        }
        floorTexture.dispose();
        nonFloorMaterial.dispose();
        floorMaterial.dispose();
      },
    };
    
  } catch (error) {
    console.error('[FaceRenovation] Error:', error);
    return {
      success: false,
      floorFaceCount: 0,
      totalFaceCount: 0,
      restore: () => {},
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
