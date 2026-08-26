/**
 * Mesh Segmentation Service
 * 
 * Analyzes 3D mesh geometry to automatically identify:
 * - Floors (horizontal surfaces facing up)
 * - Walls (vertical surfaces)
 * - Ceilings (horizontal surfaces facing down)
 * - Counters (horizontal surfaces at counter height)
 * - Fixtures (isolated mesh clusters)
 * 
 * Returns face indices for each segment, enabling direct material application.
 */

import * as THREE from 'three';

// ============================================================================
// Types
// ============================================================================

export interface SurfaceSegment {
  id: string;
  type: 'floor' | 'wall' | 'ceiling' | 'counter' | 'fixture' | 'unknown';
  faceIndices: number[];
  vertices: THREE.Vector3[];
  bounds: {
    min: THREE.Vector3;
    max: THREE.Vector3;
    center: THREE.Vector3;
    size: THREE.Vector3;
  };
  normal: THREE.Vector3; // Average normal of all faces
  area: number; // In mesh units (multiply by calibration for real units)
  // For fixtures
  fixtureType?: 'vanity' | 'toilet' | 'bathtub' | 'sink' | 'appliance' | 'cabinet' | 'unknown';
}

export interface MeshSegmentation {
  floors: SurfaceSegment[];
  walls: SurfaceSegment[];
  ceilings: SurfaceSegment[];
  counters: SurfaceSegment[];
  fixtures: SurfaceSegment[];
  unknown: SurfaceSegment[];
  totalFaces: number;
  segmentedFaces: number;
}

export interface SegmentationOptions {
  // Angle thresholds (in degrees)
  floorAngleThreshold?: number;   // Max angle from horizontal to be floor (default: 15)
  wallAngleThreshold?: number;    // Max angle from vertical to be wall (default: 15)
  
  // Height thresholds (in mesh units - will be calibrated)
  floorMaxHeight?: number;        // Max Y for floor detection
  counterMinHeight?: number;      // Min Y for counter (typically ~0.9m / 36")
  counterMaxHeight?: number;      // Max Y for counter
  ceilingMinHeight?: number;      // Min Y for ceiling detection
  
  // Clustering
  minClusterArea?: number;        // Minimum area to be a valid segment
  mergeDistance?: number;         // Distance to merge adjacent segments
}

// ============================================================================
// Main Segmentation Function
// ============================================================================

export function segmentMesh(
  mesh: THREE.Mesh | THREE.Group,
  options: SegmentationOptions = {}
): MeshSegmentation {
  console.log('[MeshSegmentation] Starting mesh analysis...');
  
  const {
    floorAngleThreshold = 15,
    wallAngleThreshold = 15,
    floorMaxHeight = 0.3,  // Height ABOVE the minimum Y to consider as floor
    counterMinHeight = 0.7,
    counterMaxHeight = 1.2,
    ceilingMinHeight = 2.0,
    minClusterArea = 0.1,
  } = options;
  
  const result: MeshSegmentation = {
    floors: [],
    walls: [],
    ceilings: [],
    counters: [],
    fixtures: [],
    unknown: [],
    totalFaces: 0,
    segmentedFaces: 0,
  };
  
  // Collect all meshes from the group
  const meshes: THREE.Mesh[] = [];
  if (mesh instanceof THREE.Mesh) {
    meshes.push(mesh);
  } else {
    mesh.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        meshes.push(child);
      }
    });
  }
  
  console.log('[MeshSegmentation] Found', meshes.length, 'mesh(es)');
  
  // FIRST PASS: Find the bounding box to determine actual floor level
  let globalMinY = Infinity;
  let globalMaxY = -Infinity;
  
  for (const m of meshes) {
    const geometry = m.geometry;
    if (!geometry) continue;
    
    const positionAttr = geometry.getAttribute('position');
    if (!positionAttr) continue;
    
    m.updateMatrixWorld(true);
    const worldMatrix = m.matrixWorld;
    const tempVec = new THREE.Vector3();
    
    for (let i = 0; i < positionAttr.count; i++) {
      tempVec.set(
        positionAttr.getX(i),
        positionAttr.getY(i),
        positionAttr.getZ(i)
      );
      tempVec.applyMatrix4(worldMatrix);
      globalMinY = Math.min(globalMinY, tempVec.y);
      globalMaxY = Math.max(globalMaxY, tempVec.y);
    }
  }
  
  const meshHeight = globalMaxY - globalMinY;
  
  // For photogrammetry scans, the floor could be at either the min or max Y depending on
  // how the scan was oriented. We'll detect floors at BOTH ends and see which has more faces.
  // 
  // IMPROVED: Use a percentage of mesh height instead of absolute value
  // This handles meshes of different scales better
  const floorThreshold = Math.max(floorMaxHeight, meshHeight * 0.15); // At least 15% of mesh height
  const ceilingThreshold = Math.max(0.3, meshHeight * 0.15);
  
  const floorNearMinY = { min: globalMinY, max: globalMinY + floorThreshold };
  const floorNearMaxY = { min: globalMaxY - floorThreshold, max: globalMaxY };
  
  // Ceiling detection at the opposite end
  const ceilingNearMinY = globalMinY + ceilingThreshold;
  const ceilingNearMaxY = globalMaxY - ceilingThreshold;
  
  console.log('[MeshSegmentation] Mesh Y range:', globalMinY.toFixed(2), 'to', globalMaxY.toFixed(2));
  console.log('[MeshSegmentation] Mesh height:', meshHeight.toFixed(2), '- Floor threshold:', floorThreshold.toFixed(2));
  console.log('[MeshSegmentation] Floor detection zones: near min Y <', floorNearMinY.max.toFixed(2), 'OR near max Y >', floorNearMaxY.min.toFixed(2));
  
  // Temporary storage for face classification
  const floorFaces: FaceData[] = [];
  const wallFaces: FaceData[] = [];
  const ceilingFaces: FaceData[] = [];
  const counterFaces: FaceData[] = [];
  const unknownFaces: FaceData[] = [];
  
  // Process each mesh
  for (const m of meshes) {
    const geometry = m.geometry;
    if (!geometry) continue;
    
    // Ensure we have computed vertex normals
    geometry.computeVertexNormals();
    
    const positionAttr = geometry.getAttribute('position');
    const normalAttr = geometry.getAttribute('normal');
    const indexAttr = geometry.getIndex();
    
    if (!positionAttr) continue;
    
    // Get world matrix for transforming to world coordinates
    m.updateMatrixWorld(true);
    const worldMatrix = m.matrixWorld;
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(worldMatrix);
    
    // Process each face (triangle)
    const faceCount = indexAttr 
      ? indexAttr.count / 3 
      : positionAttr.count / 3;
    
    result.totalFaces += faceCount;
    
    for (let i = 0; i < faceCount; i++) {
      const faceData = extractFaceData(
        geometry, 
        i, 
        worldMatrix, 
        normalMatrix,
        m.uuid
      );
      
      if (!faceData) continue;
      
      // Classify based on normal direction and height
      const normal = faceData.normal;
      const center = faceData.center;
      
      // Calculate angles
      const upVector = new THREE.Vector3(0, 1, 0);
      const downVector = new THREE.Vector3(0, -1, 0);
      const angleFromUp = THREE.MathUtils.radToDeg(normal.angleTo(upVector));
      const angleFromDown = THREE.MathUtils.radToDeg(normal.angleTo(downVector));
      
      // Horizontal facing up (floor or counter)
      // Check both floor zones (near min Y or near max Y)
      if (angleFromUp < floorAngleThreshold) {
        const isNearMinY = center.y <= floorNearMinY.max;
        const isNearMaxY = center.y >= floorNearMaxY.min;
        
        if (isNearMinY || isNearMaxY) {
          floorFaces.push(faceData);
        } else if (center.y >= globalMinY + counterMinHeight && center.y <= globalMinY + counterMaxHeight) {
          counterFaces.push(faceData);
        } else {
          // FALLBACK: If upward-facing but not at floor/counter height, still consider it a floor
          // This helps with photogrammetry scans where the floor might be at an odd height
          floorFaces.push(faceData);
        }
      }
      // Horizontal facing down (ceiling)
      // Check both ceiling zones
      else if (angleFromDown < floorAngleThreshold) {
        const isNearMinY = center.y <= ceilingNearMinY;
        const isNearMaxY = center.y >= ceilingNearMaxY;
        
        if (isNearMinY || isNearMaxY) {
          ceilingFaces.push(faceData);
        } else {
          unknownFaces.push(faceData);
        }
      }
      // Vertical (wall)
      else if (Math.abs(normal.y) < Math.sin(THREE.MathUtils.degToRad(wallAngleThreshold))) {
        wallFaces.push(faceData);
      }
      // Unknown orientation
      else {
        unknownFaces.push(faceData);
      }
    }
  }
  
  console.log('[MeshSegmentation] Classified faces:', {
    floor: floorFaces.length,
    wall: wallFaces.length,
    ceiling: ceilingFaces.length,
    counter: counterFaces.length,
    unknown: unknownFaces.length,
  });
  
  // Cluster faces into continuous segments
  result.floors = clusterFaces(floorFaces, 'floor', minClusterArea);
  result.walls = clusterFaces(wallFaces, 'wall', minClusterArea);
  result.ceilings = clusterFaces(ceilingFaces, 'ceiling', minClusterArea);
  result.counters = clusterFaces(counterFaces, 'counter', minClusterArea);
  result.unknown = clusterFaces(unknownFaces, 'unknown', minClusterArea);
  
  // Count segmented faces
  result.segmentedFaces = 
    result.floors.reduce((sum, s) => sum + s.faceIndices.length, 0) +
    result.walls.reduce((sum, s) => sum + s.faceIndices.length, 0) +
    result.ceilings.reduce((sum, s) => sum + s.faceIndices.length, 0) +
    result.counters.reduce((sum, s) => sum + s.faceIndices.length, 0);
  
  console.log('[MeshSegmentation] Created segments:', {
    floors: result.floors.length,
    walls: result.walls.length,
    ceilings: result.ceilings.length,
    counters: result.counters.length,
    unknown: result.unknown.length,
    coverage: `${(result.segmentedFaces / result.totalFaces * 100).toFixed(1)}%`,
  });
  
  return result;
}

// ============================================================================
// Face Data Extraction
// ============================================================================

interface FaceData {
  meshId: string;
  faceIndex: number;
  vertices: [THREE.Vector3, THREE.Vector3, THREE.Vector3];
  normal: THREE.Vector3;
  center: THREE.Vector3;
  area: number;
}

function extractFaceData(
  geometry: THREE.BufferGeometry,
  faceIndex: number,
  worldMatrix: THREE.Matrix4,
  normalMatrix: THREE.Matrix3,
  meshId: string
): FaceData | null {
  const positionAttr = geometry.getAttribute('position');
  const normalAttr = geometry.getAttribute('normal');
  const indexAttr = geometry.getIndex();
  
  // Get vertex indices
  let i0: number, i1: number, i2: number;
  if (indexAttr) {
    i0 = indexAttr.getX(faceIndex * 3);
    i1 = indexAttr.getX(faceIndex * 3 + 1);
    i2 = indexAttr.getX(faceIndex * 3 + 2);
  } else {
    i0 = faceIndex * 3;
    i1 = faceIndex * 3 + 1;
    i2 = faceIndex * 3 + 2;
  }
  
  // Extract vertices in world space
  const v0 = new THREE.Vector3().fromBufferAttribute(positionAttr, i0).applyMatrix4(worldMatrix);
  const v1 = new THREE.Vector3().fromBufferAttribute(positionAttr, i1).applyMatrix4(worldMatrix);
  const v2 = new THREE.Vector3().fromBufferAttribute(positionAttr, i2).applyMatrix4(worldMatrix);
  
  // Calculate face normal (in world space)
  const edge1 = new THREE.Vector3().subVectors(v1, v0);
  const edge2 = new THREE.Vector3().subVectors(v2, v0);
  const normal = new THREE.Vector3().crossVectors(edge1, edge2).normalize();
  
  // If we have vertex normals, use average for smoother classification
  if (normalAttr) {
    const n0 = new THREE.Vector3().fromBufferAttribute(normalAttr, i0).applyMatrix3(normalMatrix).normalize();
    const n1 = new THREE.Vector3().fromBufferAttribute(normalAttr, i1).applyMatrix3(normalMatrix).normalize();
    const n2 = new THREE.Vector3().fromBufferAttribute(normalAttr, i2).applyMatrix3(normalMatrix).normalize();
    normal.add(n0).add(n1).add(n2).normalize();
  }
  
  // Calculate center
  const center = new THREE.Vector3().add(v0).add(v1).add(v2).divideScalar(3);
  
  // Calculate area
  const area = edge1.cross(edge2).length() / 2;
  
  return {
    meshId,
    faceIndex,
    vertices: [v0, v1, v2],
    normal,
    center,
    area,
  };
}

// ============================================================================
// Face Clustering
// ============================================================================

/**
 * Find connected components among faces using shared vertices
 * Returns only the LARGEST connected component to eliminate scattered fragments
 */
function findLargestConnectedComponent(faces: FaceData[]): FaceData[] {
  if (faces.length === 0) return [];
  if (faces.length < 10) return faces; // Too few to cluster
  
  // Build vertex-to-face mapping
  // Two faces are connected if they share at least one vertex (within tolerance)
  const VERTEX_TOLERANCE = 0.001;
  
  // Create a spatial hash for vertices
  const vertexHash = (v: THREE.Vector3): string => {
    const x = Math.round(v.x / VERTEX_TOLERANCE);
    const y = Math.round(v.y / VERTEX_TOLERANCE);
    const z = Math.round(v.z / VERTEX_TOLERANCE);
    return `${x},${y},${z}`;
  };
  
  // Map each vertex hash to face indices
  const vertexToFaces = new Map<string, number[]>();
  
  faces.forEach((face, idx) => {
    for (const vertex of face.vertices) {
      const hash = vertexHash(vertex);
      if (!vertexToFaces.has(hash)) {
        vertexToFaces.set(hash, []);
      }
      vertexToFaces.get(hash)!.push(idx);
    }
  });
  
  // Build adjacency list for faces
  const faceNeighbors: Set<number>[] = faces.map(() => new Set());
  
  for (const [, faceIndices] of vertexToFaces) {
    // All faces sharing this vertex are neighbors
    for (let i = 0; i < faceIndices.length; i++) {
      for (let j = i + 1; j < faceIndices.length; j++) {
        faceNeighbors[faceIndices[i]].add(faceIndices[j]);
        faceNeighbors[faceIndices[j]].add(faceIndices[i]);
      }
    }
  }
  
  // BFS to find connected components
  const visited = new Set<number>();
  const components: number[][] = [];
  
  for (let startIdx = 0; startIdx < faces.length; startIdx++) {
    if (visited.has(startIdx)) continue;
    
    const component: number[] = [];
    const queue = [startIdx];
    visited.add(startIdx);
    
    while (queue.length > 0) {
      const current = queue.shift()!;
      component.push(current);
      
      for (const neighbor of faceNeighbors[current]) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    
    components.push(component);
  }
  
  // Find the largest component
  if (components.length === 0) return faces;
  
  const largestComponent = components.reduce((a, b) => a.length > b.length ? a : b);
  
  console.log(`[MeshSegmentation] Found ${components.length} connected components, largest has ${largestComponent.length} faces (total: ${faces.length})`);
  
  // Return only faces in the largest component
  return largestComponent.map(idx => faces[idx]);
}

function clusterFaces(
  faces: FaceData[],
  type: SurfaceSegment['type'],
  minArea: number
): SurfaceSegment[] {
  if (faces.length === 0) return [];
  
  // IMPORTANT: For floor and ceiling, find the largest connected component
  // This eliminates scattered fragments and keeps only the main surface
  let filteredFaces = faces;
  if (type === 'floor' || type === 'ceiling') {
    filteredFaces = findLargestConnectedComponent(faces);
  }
  
  const allVertices: THREE.Vector3[] = [];
  const faceIndices: number[] = [];
  let totalArea = 0;
  const normalSum = new THREE.Vector3();
  
  const bounds = {
    min: new THREE.Vector3(Infinity, Infinity, Infinity),
    max: new THREE.Vector3(-Infinity, -Infinity, -Infinity),
    center: new THREE.Vector3(),
    size: new THREE.Vector3(),
  };
  
  for (const face of filteredFaces) {
    faceIndices.push(face.faceIndex);
    totalArea += face.area;
    normalSum.add(face.normal);
    
    for (const v of face.vertices) {
      allVertices.push(v.clone());
      bounds.min.min(v);
      bounds.max.max(v);
    }
  }
  
  if (totalArea < minArea) {
    return [];
  }
  
  bounds.center.addVectors(bounds.min, bounds.max).divideScalar(2);
  bounds.size.subVectors(bounds.max, bounds.min);
  
  const segment: SurfaceSegment = {
    id: `${type}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    type,
    faceIndices,
    vertices: allVertices,
    bounds,
    normal: normalSum.normalize(),
    area: totalArea,
  };
  
  return [segment];
}

// ============================================================================
// Material Application
// ============================================================================

export interface MaterialDefinition {
  id: string;
  name: string;
  type: 'texture' | 'color';
  
  // For textures
  textureUrl?: string;
  normalMapUrl?: string;
  roughnessMapUrl?: string;
  
  // For colors
  color?: string;
  
  // Physical properties
  roughness?: number;
  metalness?: number;
  
  // UV scaling (real-world size of texture in inches)
  textureRealWorldSize?: { width: number; height: number };
}

/**
 * Apply a material to a specific surface segment
 */
export function applyMaterialToSegment(
  mesh: THREE.Mesh,
  segment: SurfaceSegment,
  material: MaterialDefinition,
  calibrationScaleFactor: number = 1 // mesh units to inches
): void {
  console.log('[MeshSegmentation] Applying material to segment:', segment.id);
  console.log('[MeshSegmentation] Material:', material.name);
  console.log('[MeshSegmentation] Faces to update:', segment.faceIndices.length);
  
  // Create Three.js material
  const threeMaterial = createThreeMaterial(material, calibrationScaleFactor);
  
  // For now, we'll create a new material group
  // In production, you'd want to modify the geometry to separate these faces
  
  // Store original material
  const originalMaterial = mesh.material;
  
  // Create multi-material setup
  if (Array.isArray(mesh.material)) {
    // Already multi-material, add new one
    mesh.material.push(threeMaterial);
  } else {
    // Convert to multi-material
    mesh.material = [originalMaterial as THREE.Material, threeMaterial];
  }
  
  // Update geometry groups to use new material for segment faces
  const geometry = mesh.geometry;
  if (!geometry.groups || geometry.groups.length === 0) {
    // Need to create groups
    geometry.addGroup(0, geometry.getIndex()?.count || 0, 0);
  }
  
  // Add group for our segment
  const materialIndex = Array.isArray(mesh.material) ? mesh.material.length - 1 : 1;
  
  // This is simplified - in production you'd need to reorganize the index buffer
  // to group these faces together
  console.log('[MeshSegmentation] ⚠️  Full face-level material assignment requires geometry restructuring');
  console.log('[MeshSegmentation] Applying material to entire mesh for now');
  
  // For demonstration, apply to whole mesh
  mesh.material = threeMaterial;
}

function createThreeMaterial(
  material: MaterialDefinition,
  scaleFactor: number
): THREE.Material {
  const textureLoader = new THREE.TextureLoader();
  
  if (material.type === 'color' && material.color) {
    return new THREE.MeshStandardMaterial({
      color: material.color,
      roughness: material.roughness ?? 0.7,
      metalness: material.metalness ?? 0,
    });
  }
  
  // Texture-based material
  const matProps: THREE.MeshStandardMaterialParameters = {
    roughness: material.roughness ?? 0.8,
    metalness: material.metalness ?? 0,
  };
  
  if (material.textureUrl) {
    const texture = textureLoader.load(material.textureUrl);
    
    // Scale texture based on real-world size
    if (material.textureRealWorldSize && scaleFactor > 0) {
      const textureWorldSize = material.textureRealWorldSize;
      // Calculate how many times texture should repeat
      // This would be based on the segment's real-world size
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      // Repeat will be set per-segment based on its actual size
    }
    
    matProps.map = texture;
  }
  
  if (material.normalMapUrl) {
    matProps.normalMap = textureLoader.load(material.normalMapUrl);
  }
  
  if (material.roughnessMapUrl) {
    matProps.roughnessMap = textureLoader.load(material.roughnessMapUrl);
  }
  
  return new THREE.MeshStandardMaterial(matProps);
}

// ============================================================================
// Fixture Detection
// ============================================================================

/**
 * Detect fixtures in the mesh based on isolated geometry clusters
 */
export function detectFixtures(
  mesh: THREE.Mesh | THREE.Group,
  segmentation: MeshSegmentation
): SurfaceSegment[] {
  // Fixtures are typically isolated mesh clusters that:
  // 1. Don't connect to walls/floor/ceiling
  // 2. Have a bounding box matching known fixture dimensions
  // 3. Are positioned in expected locations (vanity near wall, toilet near corner, etc.)
  
  const fixtures: SurfaceSegment[] = [];
  
  // Use the "unknown" segments as potential fixtures
  for (const segment of segmentation.unknown) {
    const size = segment.bounds.size;
    const center = segment.bounds.center;
    
    // Check if dimensions match known fixtures (in mesh units)
    // These would need to be scaled by calibration factor
    
    // Vanity: typically 24-72" wide, 20-24" deep, 30-36" tall
    if (size.x > 0.5 && size.x < 2 && size.z > 0.4 && size.z < 0.8 && size.y > 0.7 && size.y < 1.0) {
      segment.type = 'fixture';
      segment.fixtureType = 'vanity';
      fixtures.push(segment);
      continue;
    }
    
    // Toilet: typically 14-15" wide, 26-30" deep, 15-17" bowl height
    if (size.x > 0.3 && size.x < 0.5 && size.z > 0.5 && size.z < 0.8 && center.y < 0.5) {
      segment.type = 'fixture';
      segment.fixtureType = 'toilet';
      fixtures.push(segment);
      continue;
    }
    
    // Bathtub: typically 60" long, 30-32" wide
    if (size.x > 1.3 && size.x < 1.7 && size.z > 0.7 && size.z < 0.9) {
      segment.type = 'fixture';
      segment.fixtureType = 'bathtub';
      fixtures.push(segment);
      continue;
    }
  }
  
  return fixtures;
}

// ============================================================================
// Integration with Renovation Detection
// ============================================================================

/**
 * Map detected renovations to mesh segments for accurate overlay
 */
export function mapRenovationsToSegments(
  renovations: Array<{
    id: string;
    category: string;
    location: { x: number; y: number; z: number };
    bounds?: { width: number; height: number; depth: number };
  }>,
  segmentation: MeshSegmentation
): Map<string, SurfaceSegment> {
  const mapping = new Map<string, SurfaceSegment>();
  
  for (const renovation of renovations) {
    const pos = new THREE.Vector3(renovation.location.x, renovation.location.y, renovation.location.z);
    
    // Find closest matching segment
    let bestMatch: SurfaceSegment | null = null;
    let bestDistance = Infinity;
    
    const allSegments = [
      ...segmentation.floors,
      ...segmentation.walls,
      ...segmentation.counters,
      ...segmentation.fixtures,
    ];
    
    for (const segment of allSegments) {
      const distance = pos.distanceTo(segment.bounds.center);
      
      // Check if renovation type matches segment type
      const isMatch = 
        (renovation.category === 'flooring' && segment.type === 'floor') ||
        (renovation.category === 'paint' && segment.type === 'wall') ||
        (renovation.category === 'countertop' && segment.type === 'counter') ||
        (renovation.category === 'vanity' && segment.fixtureType === 'vanity') ||
        (renovation.category === 'toilet' && segment.fixtureType === 'toilet');
      
      if (isMatch && distance < bestDistance) {
        bestDistance = distance;
        bestMatch = segment;
      }
    }
    
    if (bestMatch) {
      mapping.set(renovation.id, bestMatch);
    }
  }
  
  return mapping;
}

// ============================================================================
// AI Texture Application
// ============================================================================

/**
 * Apply an AI-generated texture to a specific mesh segment
 */
export function applyAITextureToSegment(
  mesh: THREE.Mesh,
  segment: SurfaceSegment,
  texture: THREE.Texture,
  realWorldDimensions: { width: number; height: number },
  calibrationScale: number = 1
): void {
  console.log('[MeshSegmentation] Applying AI texture to segment:', segment.id);
  
  // Configure texture wrapping and repeat
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  
  // Calculate repeat based on real-world dimensions
  const segmentSize = segment.bounds.size;
  const repeatX = (segmentSize.x * calibrationScale) / realWorldDimensions.width;
  const repeatY = (segmentSize.z * calibrationScale) / realWorldDimensions.height;
  
  texture.repeat.set(repeatX, repeatY);
  texture.needsUpdate = true;
  
  console.log('[MeshSegmentation] Texture repeat:', { repeatX, repeatY });
  
  // Create material with AI texture
  const material = new THREE.MeshStandardMaterial({
    map: texture,
    roughness: segment.type === 'floor' ? 0.8 : 0.9,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  
  // Apply to mesh
  // Note: This is simplified - ideally we'd apply only to specific faces
  const geometry = mesh.geometry;
  
  // Store original material for restoration
  if (!mesh.userData.originalMaterial) {
    mesh.userData.originalMaterial = mesh.material;
  }
  
  // For now, apply to entire mesh (in production, would apply per-face)
  mesh.material = material;
  
  console.log('[MeshSegmentation] ✅ AI texture applied');
}

/**
 * Remove AI texture and restore original material
 */
export function removeAITexture(mesh: THREE.Mesh): void {
  if (mesh.userData.originalMaterial) {
    mesh.material = mesh.userData.originalMaterial;
    delete mesh.userData.originalMaterial;
    console.log('[MeshSegmentation] AI texture removed, original restored');
  }
}

/**
 * Capture a segment's geometry for texture generation
 * Returns bounds and dimensions needed for AI texture prompt
 */
export function getSegmentCaptureInfo(
  segment: SurfaceSegment,
  calibrationScale: number = 1
): {
  center: THREE.Vector3;
  size: THREE.Vector3;
  normal: THREE.Vector3;
  realWorldDimensions: { width: number; height: number; area: number };
  segmentType: 'floor' | 'wall' | 'ceiling' | 'counter';
} {
  const realWidth = segment.bounds.size.x * calibrationScale;
  const realHeight = segment.bounds.size.z * calibrationScale;
  const realArea = segment.area * calibrationScale * calibrationScale;
  
  let segmentType: 'floor' | 'wall' | 'ceiling' | 'counter' = 'floor';
  switch (segment.type) {
    case 'floor':
      segmentType = 'floor';
      break;
    case 'wall':
      segmentType = 'wall';
      break;
    case 'ceiling':
      segmentType = 'ceiling';
      break;
    case 'counter':
      segmentType = 'counter';
      break;
    default:
      segmentType = 'floor';
  }
  
  return {
    center: segment.bounds.center.clone(),
    size: segment.bounds.size.clone(),
    normal: segment.normal.clone(),
    realWorldDimensions: {
      width: realWidth,
      height: realHeight,
      area: realArea,
    },
    segmentType,
  };
}
