/**
 * Mesh Analysis Service
 * Analyzes 3D photogrammetry meshes to extract room geometry, surfaces, and
 * optimal positions for renovation zone overlays.
 */

import * as THREE from 'three';

// ============================================================================
// Types
// ============================================================================

/**
 * Analyzed mesh geometry data
 */
export interface MeshAnalysis {
  bounds: MeshBounds;
  center: THREE.Vector3;
  scale: number;  // Applied scale factor
  surfaces: DetectedSurface[];
  roomZones: RoomZone[];
  floorPlane: PlaneEstimate | null;
  ceilingPlane: PlaneEstimate | null;
  walls: PlaneEstimate[];
}

/**
 * Mesh bounding box info
 */
export interface MeshBounds {
  min: THREE.Vector3;
  max: THREE.Vector3;
  size: THREE.Vector3;
  center: THREE.Vector3;
}

/**
 * Detected surface (floor, wall, ceiling)
 */
export interface DetectedSurface {
  type: 'floor' | 'wall' | 'ceiling' | 'unknown';
  normal: THREE.Vector3;
  centroid: THREE.Vector3;
  area: number;
  vertices: THREE.Vector3[];
  boundingBox: MeshBounds;
}

/**
 * Plane estimate from RANSAC or normal clustering
 */
export interface PlaneEstimate {
  normal: THREE.Vector3;
  point: THREE.Vector3;  // Point on plane
  distance: number;  // Distance from origin
  area: number;
  confidence: number;
}

/**
 * Room zone with positioning for overlays
 */
export interface RoomZone {
  id: string;
  type: 'floor' | 'kitchen' | 'bathroom' | 'living' | 'wall' | 'ceiling' | 'general';
  bounds: MeshBounds;
  center: THREE.Vector3;
  markerPosition: THREE.Vector3;
  surfaceType: 'horizontal' | 'vertical';
  confidence: number;
}

/**
 * Renovation overlay position data  
 */
export interface OverlayPosition {
  center: THREE.Vector3;
  size: THREE.Vector3;
  markerPosition: THREE.Vector3;
  normal: THREE.Vector3;
  onMeshSurface: boolean;
}

// ============================================================================
// Mesh Analysis Functions
// ============================================================================

/**
 * Analyze a Three.js mesh/group to extract geometric information
 */
export function analyzeMesh(meshGroup: THREE.Group): MeshAnalysis {
  console.log('[MeshAnalysis] Starting mesh analysis...');
  
  // Get overall bounds
  const bounds = getMeshBounds(meshGroup);
  
  // Extract vertices and normals from all meshes (colors reserved for future color-based zone detection)
  const { vertices, normals, colors: _colors } = extractMeshData(meshGroup);
  console.log(`[MeshAnalysis] Extracted ${vertices.length} vertices`);
  
  // Detect planar surfaces
  const surfaces = detectPlanarSurfaces(vertices, normals);
  console.log(`[MeshAnalysis] Detected ${surfaces.length} surfaces`);
  
  // Identify floor, ceiling, walls
  const floorPlane = findFloorPlane(surfaces, bounds);
  const ceilingPlane = findCeilingPlane(surfaces, bounds);
  const walls = findWallPlanes(surfaces, bounds);
  
  // Generate room zones based on mesh geometry
  const roomZones = generateRoomZones(bounds, floorPlane, ceilingPlane, walls);
  
  const analysis: MeshAnalysis = {
    bounds,
    center: bounds.center.clone(),
    scale: 1,
    surfaces,
    roomZones,
    floorPlane,
    ceilingPlane,
    walls,
  };
  
  console.log('[MeshAnalysis] Analysis complete:', {
    bounds: { 
      size: [bounds.size.x.toFixed(2), bounds.size.y.toFixed(2), bounds.size.z.toFixed(2)],
    },
    hasFloor: !!floorPlane,
    hasCeiling: !!ceilingPlane,
    wallCount: walls.length,
    zoneCount: roomZones.length,
  });
  
  return analysis;
}

/**
 * Get the bounding box of a mesh group
 */
export function getMeshBounds(meshGroup: THREE.Object3D): MeshBounds {
  const box = new THREE.Box3().setFromObject(meshGroup);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  
  return {
    min: box.min.clone(),
    max: box.max.clone(),
    size,
    center,
  };
}

/**
 * Extract vertices, normals, and colors from all meshes in a group
 */
function extractMeshData(meshGroup: THREE.Object3D): {
  vertices: THREE.Vector3[];
  normals: THREE.Vector3[];
  colors: THREE.Color[];
} {
  const vertices: THREE.Vector3[] = [];
  const normals: THREE.Vector3[] = [];
  const colors: THREE.Color[] = [];
  
  meshGroup.traverse((child) => {
    if (child instanceof THREE.Mesh && child.geometry) {
      const geometry = child.geometry;
      const positionAttr = geometry.getAttribute('position');
      const normalAttr = geometry.getAttribute('normal');
      const colorAttr = geometry.getAttribute('color');
      
      if (positionAttr) {
        // Get world matrix for proper transformations
        child.updateMatrixWorld();
        const matrix = child.matrixWorld;
        const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);
        
        // Sample vertices (subsample for performance)
        const step = Math.max(1, Math.floor(positionAttr.count / 10000));
        
        for (let i = 0; i < positionAttr.count; i += step) {
          const vertex = new THREE.Vector3(
            positionAttr.getX(i),
            positionAttr.getY(i),
            positionAttr.getZ(i)
          );
          vertex.applyMatrix4(matrix);
          vertices.push(vertex);
          
          if (normalAttr) {
            const normal = new THREE.Vector3(
              normalAttr.getX(i),
              normalAttr.getY(i),
              normalAttr.getZ(i)
            );
            normal.applyMatrix3(normalMatrix).normalize();
            normals.push(normal);
          }
          
          if (colorAttr) {
            colors.push(new THREE.Color(
              colorAttr.getX(i),
              colorAttr.getY(i),
              colorAttr.getZ(i)
            ));
          }
        }
      }
    }
  });
  
  return { vertices, normals, colors };
}

/**
 * Detect planar surfaces using normal clustering
 */
function detectPlanarSurfaces(
  vertices: THREE.Vector3[],
  normals: THREE.Vector3[]
): DetectedSurface[] {
  if (normals.length === 0) {
    console.warn('[MeshAnalysis] No normals available, skipping surface detection');
    return [];
  }
  
  const surfaces: DetectedSurface[] = [];
  
  // Cluster normals to find dominant surfaces
  // Simple approach: bin normals by direction
  const normalBins = new Map<string, { vertices: THREE.Vector3[], normals: THREE.Vector3[] }>();
  
  // Threshold for normal clustering: ~17 degrees tolerance
  // Used implicitly via Math.abs checks below (0.8 ≈ cos(37°), 0.3 ≈ cos(73°))
  
  vertices.forEach((vertex, idx) => {
    if (idx >= normals.length) return;
    
    const normal = normals[idx];
    
    // Determine surface type by normal direction
    let binKey: string;
    if (Math.abs(normal.y) > 0.8) {
      // Horizontal surface (floor or ceiling)
      binKey = normal.y > 0 ? 'floor' : 'ceiling';
    } else if (Math.abs(normal.y) < 0.3) {
      // Vertical surface (wall)
      // Bin by approximate wall direction
      const angle = Math.atan2(normal.z, normal.x);
      const binAngle = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
      binKey = `wall_${binAngle.toFixed(2)}`;
    } else {
      binKey = 'unknown';
    }
    
    if (!normalBins.has(binKey)) {
      normalBins.set(binKey, { vertices: [], normals: [] });
    }
    normalBins.get(binKey)!.vertices.push(vertex);
    normalBins.get(binKey)!.normals.push(normal);
  });
  
  // Create surfaces from bins
  normalBins.forEach((bin, key) => {
    if (bin.vertices.length < 50) return; // Skip small clusters
    
    const centroid = bin.vertices.reduce(
      (acc, v) => acc.add(v.clone().divideScalar(bin.vertices.length)),
      new THREE.Vector3()
    );
    
    const avgNormal = bin.normals.reduce(
      (acc, n) => acc.add(n.clone().divideScalar(bin.normals.length)),
      new THREE.Vector3()
    ).normalize();
    
    // Calculate approximate area from vertex spread
    const bb = new THREE.Box3().setFromPoints(bin.vertices);
    const size = bb.getSize(new THREE.Vector3());
    const area = size.x * size.y + size.y * size.z + size.x * size.z;
    
    let type: DetectedSurface['type'] = 'unknown';
    if (key === 'floor') type = 'floor';
    else if (key === 'ceiling') type = 'ceiling';
    else if (key.startsWith('wall')) type = 'wall';
    
    surfaces.push({
      type,
      normal: avgNormal,
      centroid,
      area,
      vertices: bin.vertices,
      boundingBox: {
        min: bb.min.clone(),
        max: bb.max.clone(),
        size,
        center: bb.getCenter(new THREE.Vector3()),
      },
    });
  });
  
  return surfaces;
}

/**
 * Find the floor plane from detected surfaces
 */
function findFloorPlane(surfaces: DetectedSurface[], bounds: MeshBounds): PlaneEstimate | null {
  const floorSurfaces = surfaces.filter(s => s.type === 'floor');
  
  if (floorSurfaces.length === 0) {
    // Estimate floor as bottom of bounds
    return {
      normal: new THREE.Vector3(0, 1, 0),
      point: new THREE.Vector3(bounds.center.x, bounds.min.y, bounds.center.z),
      distance: bounds.min.y,
      area: bounds.size.x * bounds.size.z,
      confidence: 0.5,
    };
  }
  
  // Use largest floor surface
  const largest = floorSurfaces.reduce((a, b) => a.area > b.area ? a : b);
  
  return {
    normal: largest.normal.clone(),
    point: largest.centroid.clone(),
    distance: largest.centroid.y,
    area: largest.area,
    confidence: 0.8,
  };
}

/**
 * Find the ceiling plane from detected surfaces
 */
function findCeilingPlane(surfaces: DetectedSurface[], bounds: MeshBounds): PlaneEstimate | null {
  const ceilingSurfaces = surfaces.filter(s => s.type === 'ceiling');
  
  if (ceilingSurfaces.length === 0) {
    // Estimate ceiling as top of bounds
    return {
      normal: new THREE.Vector3(0, -1, 0),
      point: new THREE.Vector3(bounds.center.x, bounds.max.y, bounds.center.z),
      distance: bounds.max.y,
      area: bounds.size.x * bounds.size.z,
      confidence: 0.5,
    };
  }
  
  // Use largest ceiling surface
  const largest = ceilingSurfaces.reduce((a, b) => a.area > b.area ? a : b);
  
  return {
    normal: largest.normal.clone(),
    point: largest.centroid.clone(),
    distance: largest.centroid.y,
    area: largest.area,
    confidence: 0.8,
  };
}

/**
 * Find wall planes from detected surfaces
 */
function findWallPlanes(surfaces: DetectedSurface[], bounds: MeshBounds): PlaneEstimate[] {
  const wallSurfaces = surfaces.filter(s => s.type === 'wall');
  
  if (wallSurfaces.length === 0) {
    // Estimate 4 walls from bounds
    return [
      { // North wall
        normal: new THREE.Vector3(0, 0, 1),
        point: new THREE.Vector3(bounds.center.x, bounds.center.y, bounds.min.z),
        distance: bounds.min.z,
        area: bounds.size.x * bounds.size.y,
        confidence: 0.3,
      },
      { // South wall
        normal: new THREE.Vector3(0, 0, -1),
        point: new THREE.Vector3(bounds.center.x, bounds.center.y, bounds.max.z),
        distance: bounds.max.z,
        area: bounds.size.x * bounds.size.y,
        confidence: 0.3,
      },
      { // East wall
        normal: new THREE.Vector3(-1, 0, 0),
        point: new THREE.Vector3(bounds.max.x, bounds.center.y, bounds.center.z),
        distance: bounds.max.x,
        area: bounds.size.y * bounds.size.z,
        confidence: 0.3,
      },
      { // West wall
        normal: new THREE.Vector3(1, 0, 0),
        point: new THREE.Vector3(bounds.min.x, bounds.center.y, bounds.center.z),
        distance: bounds.min.x,
        area: bounds.size.y * bounds.size.z,
        confidence: 0.3,
      },
    ];
  }
  
  return wallSurfaces.map(s => ({
    normal: s.normal.clone(),
    point: s.centroid.clone(),
    distance: s.normal.dot(s.centroid),
    area: s.area,
    confidence: 0.7,
  }));
}

/**
 * Generate room zones based on analyzed geometry
 */
function generateRoomZones(
  bounds: MeshBounds,
  floor: PlaneEstimate | null,
  ceiling: PlaneEstimate | null,
  _walls: PlaneEstimate[]  // Reserved for advanced wall-specific zone generation
): RoomZone[] {
  const zones: RoomZone[] = [];
  const floorY = floor?.point.y ?? bounds.min.y;
  const ceilingY = ceiling?.point.y ?? bounds.max.y;
  const roomHeight = ceilingY - floorY;
  
  // Floor zone (for flooring renovations)
  zones.push({
    id: 'zone-floor',
    type: 'floor',
    bounds: {
      min: new THREE.Vector3(bounds.min.x, floorY, bounds.min.z),
      max: new THREE.Vector3(bounds.max.x, floorY + 0.05, bounds.max.z),
      size: new THREE.Vector3(bounds.size.x, 0.05, bounds.size.z),
      center: new THREE.Vector3(bounds.center.x, floorY + 0.025, bounds.center.z),
    },
    center: new THREE.Vector3(bounds.center.x, floorY, bounds.center.z),
    markerPosition: new THREE.Vector3(bounds.center.x, floorY + 0.5, bounds.center.z),
    surfaceType: 'horizontal',
    confidence: floor?.confidence ?? 0.5,
  });
  
  // Ceiling zone (for lighting, ceiling work)
  zones.push({
    id: 'zone-ceiling',
    type: 'ceiling',
    bounds: {
      min: new THREE.Vector3(bounds.min.x, ceilingY - 0.05, bounds.min.z),
      max: new THREE.Vector3(bounds.max.x, ceilingY, bounds.max.z),
      size: new THREE.Vector3(bounds.size.x, 0.05, bounds.size.z),
      center: new THREE.Vector3(bounds.center.x, ceilingY - 0.025, bounds.center.z),
    },
    center: new THREE.Vector3(bounds.center.x, ceilingY, bounds.center.z),
    markerPosition: new THREE.Vector3(bounds.center.x, ceilingY - 0.3, bounds.center.z),
    surfaceType: 'horizontal',
    confidence: ceiling?.confidence ?? 0.5,
  });
  
  // Wall zones (for paint, etc.)
  // Divide room into quadrants for different wall areas
  const quadrants = [
    { name: 'north-wall', x: bounds.center.x, z: bounds.min.z + bounds.size.z * 0.1 },
    { name: 'south-wall', x: bounds.center.x, z: bounds.max.z - bounds.size.z * 0.1 },
    { name: 'east-wall', x: bounds.max.x - bounds.size.x * 0.1, z: bounds.center.z },
    { name: 'west-wall', x: bounds.min.x + bounds.size.x * 0.1, z: bounds.center.z },
  ];
  
  quadrants.forEach((q, i) => {
    zones.push({
      id: `zone-wall-${i}`,
      type: 'wall',
      bounds: {
        min: new THREE.Vector3(q.x - 1, floorY, q.z - 1),
        max: new THREE.Vector3(q.x + 1, ceilingY, q.z + 1),
        size: new THREE.Vector3(2, roomHeight, 2),
        center: new THREE.Vector3(q.x, floorY + roomHeight / 2, q.z),
      },
      center: new THREE.Vector3(q.x, floorY + roomHeight / 2, q.z),
      markerPosition: new THREE.Vector3(q.x, floorY + roomHeight * 0.6, q.z),
      surfaceType: 'vertical',
      confidence: 0.6,
    });
  });
  
  // Kitchen zone (typically one corner/side of room)
  zones.push({
    id: 'zone-kitchen',
    type: 'kitchen',
    bounds: {
      min: new THREE.Vector3(bounds.min.x, floorY, bounds.min.z),
      max: new THREE.Vector3(bounds.center.x, floorY + roomHeight * 0.8, bounds.center.z),
      size: new THREE.Vector3(bounds.size.x / 2, roomHeight * 0.8, bounds.size.z / 2),
      center: new THREE.Vector3(
        bounds.min.x + bounds.size.x * 0.25,
        floorY + roomHeight * 0.4,
        bounds.min.z + bounds.size.z * 0.25
      ),
    },
    center: new THREE.Vector3(
      bounds.min.x + bounds.size.x * 0.25,
      floorY + roomHeight * 0.4,
      bounds.min.z + bounds.size.z * 0.25
    ),
    markerPosition: new THREE.Vector3(
      bounds.min.x + bounds.size.x * 0.25,
      floorY + roomHeight * 0.7,
      bounds.min.z + bounds.size.z * 0.25
    ),
    surfaceType: 'vertical',
    confidence: 0.5,
  });
  
  // Bathroom zone (typically another corner)
  zones.push({
    id: 'zone-bathroom',
    type: 'bathroom',
    bounds: {
      min: new THREE.Vector3(bounds.center.x, floorY, bounds.min.z),
      max: new THREE.Vector3(bounds.max.x, floorY + roomHeight * 0.8, bounds.center.z),
      size: new THREE.Vector3(bounds.size.x / 2, roomHeight * 0.8, bounds.size.z / 2),
      center: new THREE.Vector3(
        bounds.max.x - bounds.size.x * 0.25,
        floorY + roomHeight * 0.4,
        bounds.min.z + bounds.size.z * 0.25
      ),
    },
    center: new THREE.Vector3(
      bounds.max.x - bounds.size.x * 0.25,
      floorY + roomHeight * 0.4,
      bounds.min.z + bounds.size.z * 0.25
    ),
    markerPosition: new THREE.Vector3(
      bounds.max.x - bounds.size.x * 0.25,
      floorY + roomHeight * 0.6,
      bounds.min.z + bounds.size.z * 0.25
    ),
    surfaceType: 'vertical',
    confidence: 0.5,
  });
  
  // Living/general zone (center of room)
  zones.push({
    id: 'zone-living',
    type: 'living',
    bounds: {
      min: new THREE.Vector3(
        bounds.min.x + bounds.size.x * 0.2,
        floorY,
        bounds.min.z + bounds.size.z * 0.2
      ),
      max: new THREE.Vector3(
        bounds.max.x - bounds.size.x * 0.2,
        floorY + roomHeight * 0.8,
        bounds.max.z - bounds.size.z * 0.2
      ),
      size: new THREE.Vector3(bounds.size.x * 0.6, roomHeight * 0.8, bounds.size.z * 0.6),
      center: bounds.center.clone(),
    },
    center: new THREE.Vector3(bounds.center.x, floorY + roomHeight * 0.4, bounds.center.z),
    markerPosition: new THREE.Vector3(bounds.center.x, floorY + roomHeight * 0.5, bounds.center.z),
    surfaceType: 'horizontal',
    confidence: 0.7,
  });
  
  return zones;
}

// ============================================================================
// Overlay Position Calculation
// ============================================================================

/**
 * Calculate overlay position for a renovation based on mesh analysis
 */
export function calculateOverlayPosition(
  renovationType: string,
  meshAnalysis: MeshAnalysis,
  index: number = 0
): OverlayPosition {
  const { bounds, floorPlane, ceilingPlane, roomZones } = meshAnalysis;
  
  const floorY = floorPlane?.point.y ?? bounds.min.y;
  const ceilingY = ceilingPlane?.point.y ?? bounds.max.y;
  const roomHeight = ceilingY - floorY;
  
  // Find matching zone or create one
  let matchingZone = roomZones.find(z => z.type === renovationType);
  
  // Map renovation types to zone types
  const typeMapping: Record<string, string> = {
    kitchen: 'kitchen',
    cabinets: 'kitchen',
    countertops: 'kitchen',
    appliances: 'kitchen',
    bathroom: 'bathroom',
    flooring: 'floor',
    paint: 'wall',
    walls: 'wall',
    lighting: 'ceiling',
    ceiling: 'ceiling',
    hvac: 'ceiling',
    windows: 'wall',
    doors: 'wall',
  };
  
  const mappedType = typeMapping[renovationType] || 'general';
  if (!matchingZone) {
    matchingZone = roomZones.find(z => z.type === mappedType);
  }
  
  if (matchingZone) {
    // Add slight offset based on index to prevent overlapping markers
    const offset = new THREE.Vector3(
      (index % 3 - 1) * 0.3,
      0,
      (Math.floor(index / 3) % 3 - 1) * 0.3
    );
    
    return {
      center: matchingZone.center.clone(),
      size: matchingZone.bounds.size.clone(),
      markerPosition: matchingZone.markerPosition.clone().add(offset),
      normal: matchingZone.surfaceType === 'horizontal' 
        ? new THREE.Vector3(0, 1, 0)
        : new THREE.Vector3(0, 0, 1),
      onMeshSurface: true,
    };
  }
  
  // Fallback: position based on type
  const positions = getDefaultPosition(renovationType, bounds, floorY, ceilingY, roomHeight);
  
  return {
    ...positions,
    onMeshSurface: false,
  };
}

/**
 * Get default position for a renovation type
 */
function getDefaultPosition(
  type: string,
  bounds: MeshBounds,
  floorY: number,
  ceilingY: number,
  roomHeight: number
): Omit<OverlayPosition, 'onMeshSurface'> {
  const { size, center } = bounds;
  
  const positions: Record<string, Omit<OverlayPosition, 'onMeshSurface'>> = {
    kitchen: {
      center: new THREE.Vector3(bounds.min.x + size.x * 0.3, floorY + roomHeight * 0.4, bounds.min.z + size.z * 0.3),
      size: new THREE.Vector3(size.x * 0.4, roomHeight * 0.7, size.z * 0.4),
      markerPosition: new THREE.Vector3(bounds.min.x + size.x * 0.3, floorY + roomHeight * 0.7, bounds.min.z + size.z * 0.3),
      normal: new THREE.Vector3(1, 0, 0),
    },
    bathroom: {
      center: new THREE.Vector3(bounds.max.x - size.x * 0.3, floorY + roomHeight * 0.4, bounds.min.z + size.z * 0.3),
      size: new THREE.Vector3(size.x * 0.3, roomHeight * 0.7, size.z * 0.3),
      markerPosition: new THREE.Vector3(bounds.max.x - size.x * 0.3, floorY + roomHeight * 0.6, bounds.min.z + size.z * 0.3),
      normal: new THREE.Vector3(-1, 0, 0),
    },
    flooring: {
      center: new THREE.Vector3(center.x, floorY + 0.02, center.z),
      size: new THREE.Vector3(size.x * 0.8, 0.05, size.z * 0.8),
      markerPosition: new THREE.Vector3(center.x, floorY + 0.5, center.z),
      normal: new THREE.Vector3(0, 1, 0),
    },
    paint: {
      center: new THREE.Vector3(bounds.min.x + size.x * 0.1, floorY + roomHeight * 0.5, center.z),
      size: new THREE.Vector3(0.1, roomHeight * 0.8, size.z * 0.6),
      markerPosition: new THREE.Vector3(bounds.min.x + size.x * 0.1, floorY + roomHeight * 0.6, center.z),
      normal: new THREE.Vector3(1, 0, 0),
    },
    lighting: {
      center: new THREE.Vector3(center.x, ceilingY - 0.1, center.z),
      size: new THREE.Vector3(1.5, 0.2, 1.5),
      markerPosition: new THREE.Vector3(center.x, ceilingY - 0.3, center.z),
      normal: new THREE.Vector3(0, -1, 0),
    },
    windows: {
      center: new THREE.Vector3(bounds.max.x - 0.1, floorY + roomHeight * 0.5, center.z),
      size: new THREE.Vector3(0.1, roomHeight * 0.4, size.z * 0.3),
      markerPosition: new THREE.Vector3(bounds.max.x - 0.3, floorY + roomHeight * 0.55, center.z),
      normal: new THREE.Vector3(-1, 0, 0),
    },
    cabinets: {
      center: new THREE.Vector3(bounds.min.x + size.x * 0.25, floorY + roomHeight * 0.45, bounds.min.z + size.z * 0.25),
      size: new THREE.Vector3(size.x * 0.35, roomHeight * 0.6, size.z * 0.25),
      markerPosition: new THREE.Vector3(bounds.min.x + size.x * 0.25, floorY + roomHeight * 0.65, bounds.min.z + size.z * 0.25),
      normal: new THREE.Vector3(1, 0, 1).normalize(),
    },
    countertops: {
      center: new THREE.Vector3(bounds.min.x + size.x * 0.25, floorY + roomHeight * 0.36, bounds.min.z + size.z * 0.25),
      size: new THREE.Vector3(size.x * 0.35, 0.05, size.z * 0.25),
      markerPosition: new THREE.Vector3(bounds.min.x + size.x * 0.25, floorY + roomHeight * 0.45, bounds.min.z + size.z * 0.25),
      normal: new THREE.Vector3(0, 1, 0),
    },
  };
  
  return positions[type] || {
    center: center.clone(),
    size: new THREE.Vector3(size.x * 0.3, roomHeight * 0.5, size.z * 0.3),
    markerPosition: new THREE.Vector3(center.x, floorY + roomHeight * 0.5, center.z),
    normal: new THREE.Vector3(0, 0, 1),
  };
}

/**
 * Adjust renovation positions to match actual mesh bounds
 */
export function adjustRenovationsToMesh(
  renovations: any[],
  meshAnalysis: MeshAnalysis
): any[] {
  return renovations.map((renovation, index) => {
    const position = calculateOverlayPosition(
      renovation.zone.type,
      meshAnalysis,
      index
    );
    
    return {
      ...renovation,
      zone: {
        ...renovation.zone,
        boundingBox: {
          min: {
            x: position.center.x - position.size.x / 2,
            y: position.center.y - position.size.y / 2,
            z: position.center.z - position.size.z / 2,
          },
          max: {
            x: position.center.x + position.size.x / 2,
            y: position.center.y + position.size.y / 2,
            z: position.center.z + position.size.z / 2,
          },
          center: {
            x: position.center.x,
            y: position.center.y,
            z: position.center.z,
          },
        },
        markerPosition: {
          x: position.markerPosition.x,
          y: position.markerPosition.y,
          z: position.markerPosition.z,
        },
      },
    };
  });
}
