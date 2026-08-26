/**
 * Mesh Export Service
 * 
 * Exports Three.js geometry segments to OBJ format for backend processing
 */

import * as THREE from 'three';
import type { SurfaceSegment } from './meshSegmentationService';

/**
 * Export a surface segment to OBJ format
 * Preserves world coordinates for proper reassembly
 */
export function exportSegmentToOBJ(
  mesh: THREE.Mesh,
  segment: SurfaceSegment
): string {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const uv = geometry.getAttribute('uv');
  
  let objContent = '# OBJ file generated from Three.js segment\n';
  objContent += `# Segment type: ${segment.type}\n`;
  objContent += `# Face count: ${segment.faceIndices.length}\n\n`;
  
  // Get world matrix to preserve world coordinates
  const worldMatrix = mesh.matrixWorld;
  const vertex = new THREE.Vector3();
  
  // Track which vertices are used
  const usedVertices = new Set<number>();
  const faceSet = new Set(segment.faceIndices);
  
  // Find all vertices used by this segment's faces
  segment.faceIndices.forEach(faceIndex => {
    const startIdx = faceIndex * 3;
    for (let i = 0; i < 3; i++) {
      const vertexIndex = index ? index.getX(startIdx + i) : startIdx + i;
      usedVertices.add(vertexIndex);
    }
  });
  
  // Create vertex index mapping
  const vertexMap = new Map<number, number>();
  let newVertexIndex = 1; // OBJ uses 1-based indexing
  
  // Export vertices in world coordinates
  usedVertices.forEach(oldIndex => {
    vertex.fromBufferAttribute(position, oldIndex);
    vertex.applyMatrix4(worldMatrix); // Apply world transform
    
    objContent += `v ${vertex.x.toFixed(6)} ${vertex.y.toFixed(6)} ${vertex.z.toFixed(6)}\n`;
    vertexMap.set(oldIndex, newVertexIndex++);
  });
  
  objContent += '\n';
  
  // Export UVs if available
  if (uv) {
    usedVertices.forEach(oldIndex => {
      const u = uv.getX(oldIndex);
      const v = uv.getY(oldIndex);
      objContent += `vt ${u.toFixed(6)} ${v.toFixed(6)}\n`;
    });
    objContent += '\n';
  }
  
  // Export faces
  segment.faceIndices.forEach(faceIndex => {
    const startIdx = faceIndex * 3;
    const indices: number[] = [];
    
    for (let i = 0; i < 3; i++) {
      const oldVertexIndex = index ? index.getX(startIdx + i) : startIdx + i;
      const newVertexIndex = vertexMap.get(oldVertexIndex)!;
      indices.push(newVertexIndex);
    }
    
    if (uv) {
      objContent += `f ${indices[0]}/${indices[0]} ${indices[1]}/${indices[1]} ${indices[2]}/${indices[2]}\n`;
    } else {
      objContent += `f ${indices[0]} ${indices[1]} ${indices[2]}\n`;
    }
  });
  
  return objContent;
}

/**
 * Export the remainder (all faces NOT in the segment)
 */
export function exportRemainderToOBJ(
  mesh: THREE.Mesh,
  excludedFaceIndices: number[]
): string {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const uv = geometry.getAttribute('uv');
  
  const totalFaces = index ? index.count / 3 : position.count / 3;
  const excludedSet = new Set(excludedFaceIndices);
  
  let objContent = '# OBJ file - mesh remainder\n';
  objContent += `# Total faces: ${totalFaces - excludedFaceIndices.length}\n\n`;
  
  const worldMatrix = mesh.matrixWorld;
  const vertex = new THREE.Vector3();
  
  // Find all faces NOT in the excluded set
  const remainderFaces: number[] = [];
  for (let i = 0; i < totalFaces; i++) {
    if (!excludedSet.has(i)) {
      remainderFaces.push(i);
    }
  }
  
  // Track used vertices
  const usedVertices = new Set<number>();
  remainderFaces.forEach(faceIndex => {
    const startIdx = faceIndex * 3;
    for (let i = 0; i < 3; i++) {
      const vertexIndex = index ? index.getX(startIdx + i) : startIdx + i;
      usedVertices.add(vertexIndex);
    }
  });
  
  const vertexMap = new Map<number, number>();
  let newVertexIndex = 1;
  
  // Export vertices
  usedVertices.forEach(oldIndex => {
    vertex.fromBufferAttribute(position, oldIndex);
    vertex.applyMatrix4(worldMatrix);
    
    objContent += `v ${vertex.x.toFixed(6)} ${vertex.y.toFixed(6)} ${vertex.z.toFixed(6)}\n`;
    vertexMap.set(oldIndex, newVertexIndex++);
  });
  
  objContent += '\n';
  
  // Export UVs
  if (uv) {
    usedVertices.forEach(oldIndex => {
      const u = uv.getX(oldIndex);
      const v = uv.getY(oldIndex);
      objContent += `vt ${u.toFixed(6)} ${v.toFixed(6)}\n`;
    });
    objContent += '\n';
  }
  
  // Export faces
  remainderFaces.forEach(faceIndex => {
    const startIdx = faceIndex * 3;
    const indices: number[] = [];
    
    for (let i = 0; i < 3; i++) {
      const oldVertexIndex = index ? index.getX(startIdx + i) : startIdx + i;
      const newVertexIndex = vertexMap.get(oldVertexIndex)!;
      indices.push(newVertexIndex);
    }
    
    if (uv) {
      objContent += `f ${indices[0]}/${indices[0]} ${indices[1]}/${indices[1]} ${indices[2]}/${indices[2]}\n`;
    } else {
      objContent += `f ${indices[0]} ${indices[1]} ${indices[2]}\n`;
    }
  });
  
  return objContent;
}

/**
 * Upload OBJ content to server
 */
export async function uploadOBJToServer(
  objContent: string,
  filename: string
): Promise<{ success: boolean; url?: string; error?: string }> {
  try {
    const response = await fetch('/api/mesh/upload-obj', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ objContent, filename }),
    });
    
    return response.json();
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}
