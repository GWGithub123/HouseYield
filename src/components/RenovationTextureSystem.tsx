/**
 * RenovationTextureSystem v2
 * 
 * Applies renovation materials to 3D mesh surfaces using a multi-surface shader.
 * This shader applies different materials based on surface normal direction,
 * so a single mesh can have floor texture on horizontal-up surfaces,
 * wall paint on vertical surfaces, and ceiling on horizontal-down surfaces.
 * 
 * Key improvement: Works on single-mesh photogrammetry scans by using
 * per-pixel normal detection instead of per-mesh classification.
 */

import { useEffect, useRef, useMemo, useCallback } from 'react';
import * as THREE from 'three';
import { Html } from '@react-three/drei';
import type { CalibrationResult } from '../services/meshCalibrationService';
import { 
  createMultiSurfaceMaterial, 
  updateMultiSurfaceMaterial 
} from '../shaders/multiSurfaceMaterial';
import {
  RenovationMaterial,
  FLOORING_MATERIALS,
  WALL_MATERIALS,
  CEILING_MATERIALS,
  getMaterialById,
  generateProceduralTexture,
  calculateRenovationCost,
  RenovationCostEstimate,
} from '../data/renovationMaterials';

// ============================================================================
// Types
// ============================================================================

export interface RenovationSelection {
  flooringId: string | null;
  wallId: string | null;
  ceilingId: string | null;
}

export interface RenovationCostSummary {
  items: RenovationCostEstimate[];
  totalMaterialCost: number;
  totalLaborCost: number;
  grandTotal: number;
  estimatedValueIncrease: number;
  overallROI: number;
}

interface RenovationTextureSystemProps {
  meshGroup: THREE.Group | null;
  calibration: CalibrationResult | null;
  isPreviewMode: boolean;
  selectedMaterials: RenovationSelection;
  onCostCalculated?: (summary: RenovationCostSummary) => void;
  aiOnlyMode?: boolean; // When true, don't apply preset textures - only cost calculation
}

// ============================================================================
// Area Estimation
// ============================================================================

interface SurfaceAreas {
  floorArea: number;
  wallArea: number;
  ceilingArea: number;
}

function estimateSurfaceAreas(meshGroup: THREE.Group): SurfaceAreas {
  let floorArea = 0;
  let wallArea = 0;
  let ceilingArea = 0;
  
  meshGroup.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    
    const mesh = child as THREE.Mesh;
    const geometry = mesh.geometry as THREE.BufferGeometry;
    if (!geometry) return;
    
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    if (!position || !normal) return;
    
    mesh.updateMatrixWorld(true);
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
    
    // Analyze each face
    const faceCount = position.count / 3;
    
    for (let i = 0; i < faceCount; i++) {
      const idx = i * 3;
      
      // Get vertices
      const v0 = new THREE.Vector3(position.getX(idx), position.getY(idx), position.getZ(idx));
      const v1 = new THREE.Vector3(position.getX(idx + 1), position.getY(idx + 1), position.getZ(idx + 1));
      const v2 = new THREE.Vector3(position.getX(idx + 2), position.getY(idx + 2), position.getZ(idx + 2));
      
      // Calculate face area
      const edge1 = new THREE.Vector3().subVectors(v1, v0);
      const edge2 = new THREE.Vector3().subVectors(v2, v0);
      const cross = new THREE.Vector3().crossVectors(edge1, edge2);
      const faceArea = cross.length() / 2;
      
      // Get average normal
      const nx = (normal.getX(idx) + normal.getX(idx + 1) + normal.getX(idx + 2)) / 3;
      const ny = (normal.getY(idx) + normal.getY(idx + 1) + normal.getY(idx + 2)) / 3;
      const nz = (normal.getZ(idx) + normal.getZ(idx + 1) + normal.getZ(idx + 2)) / 3;
      
      const worldNormal = new THREE.Vector3(nx, ny, nz);
      worldNormal.applyMatrix3(normalMatrix).normalize();
      
      const upDot = worldNormal.y;
      
      // Classify and accumulate area
      if (upDot > 0.5) {
        floorArea += faceArea;
      } else if (upDot < -0.5) {
        ceilingArea += faceArea;
      } else if (Math.abs(upDot) < 0.5) {
        wallArea += faceArea;
      }
    }
  });
  
  return { floorArea, wallArea, ceilingArea };
}

// ============================================================================
// Main Component
// ============================================================================

export function RenovationTextureSystem({
  meshGroup,
  calibration,
  isPreviewMode,
  selectedMaterials,
  onCostCalculated,
  aiOnlyMode = true, // Default to AI-only mode - no automatic preset textures
}: RenovationTextureSystemProps) {
  // Store original materials for restoration
  const originalMaterialsRef = useRef<Map<THREE.Mesh, THREE.Material | THREE.Material[]>>(new Map());
  const shaderMaterialRef = useRef<THREE.ShaderMaterial | null>(null);
  const textureCache = useRef<Map<string, THREE.CanvasTexture>>(new Map());
  const hasAppliedRef = useRef(false);
  
  // Get calibration scale (mesh units to inches)
  const calibrationScale = useMemo(() => {
    if (calibration?.success) {
      return calibration.scaleFactor;
    }
    return 12; // Default: 1 unit = 12 inches (1 foot)
  }, [calibration]);
  
  // Get or create procedural texture for a material
  const getTexture = useCallback((materialDef: RenovationMaterial): THREE.CanvasTexture => {
    const cached = textureCache.current.get(materialDef.id);
    if (cached) return cached;
    
    const texture = generateProceduralTexture(materialDef, 512);
    textureCache.current.set(materialDef.id, texture);
    return texture;
  }, []);
  
  // Apply or remove materials based on preview mode and selection
  useEffect(() => {
    if (!meshGroup) {
      // console.log('[RenovationTexture] No mesh group');
      return;
    }
    
    // In AI-only mode, skip automatic texture application - only calculate costs
    if (aiOnlyMode) {
      // console.log('[RenovationTexture] AI-only mode - skipping preset textures');
      return;
    }
    
    if (isPreviewMode) {
      // console.log('[RenovationTexture] Applying renovation materials...', selectedMaterials);
      
      // Get material definitions
      const floorMat = selectedMaterials.flooringId ? getMaterialById(selectedMaterials.flooringId) : null;
      const wallMat = selectedMaterials.wallId ? getMaterialById(selectedMaterials.wallId) : null;
      const ceilingMat = selectedMaterials.ceilingId ? getMaterialById(selectedMaterials.ceilingId) : null;
      
      // console.log('[RenovationTexture] Floor:', floorMat?.name, 'Wall:', wallMat?.name, 'Ceiling:', ceilingMat?.name);
      
      // Create or update the multi-surface shader material
      if (!shaderMaterialRef.current) {
        shaderMaterialRef.current = createMultiSurfaceMaterial({
          floorColor: floorMat?.color,
          floorTexture: floorMat ? getTexture(floorMat) : undefined,
          floorTextureScale: floorMat?.textureSizeInches,
          applyFloor: !!floorMat,
          
          wallColor: wallMat?.color,
          wallTexture: wallMat ? getTexture(wallMat) : undefined,
          wallTextureScale: wallMat?.textureSizeInches,
          applyWall: !!wallMat,
          
          ceilingColor: ceilingMat?.color,
          ceilingTexture: ceilingMat ? getTexture(ceilingMat) : undefined,
          ceilingTextureScale: ceilingMat?.textureSizeInches,
          applyCeiling: !!ceilingMat,
          
          calibrationScale,
        });
      } else {
        // Update existing material
        updateMultiSurfaceMaterial(shaderMaterialRef.current, {
          floorColor: floorMat?.color,
          applyFloor: !!floorMat,
          wallColor: wallMat?.color,
          applyWall: !!wallMat,
          ceilingColor: ceilingMat?.color,
          applyCeiling: !!ceilingMat,
        });
      }
      
      // Apply shader material to all meshes, passing original texture
      meshGroup.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        
        const mesh = child as THREE.Mesh;
        
        // Skip meshes with AI-generated textures
        if (mesh.userData.hasAITexture) {
          return;
        }
        
        // Store original material if not already stored
        if (!originalMaterialsRef.current.has(mesh)) {
          originalMaterialsRef.current.set(mesh, mesh.material);
        }
        
        // Get original texture from mesh's current material
        const originalMat = originalMaterialsRef.current.get(mesh);
        let originalMap: THREE.Texture | null = null;
        let originalColor: THREE.Color = new THREE.Color(0x888888);
        
        if (originalMat && !Array.isArray(originalMat)) {
          // Try to get the map texture from MeshStandardMaterial or MeshBasicMaterial
          if ('map' in originalMat && originalMat.map) {
            originalMap = originalMat.map as THREE.Texture;
          }
          if ('color' in originalMat && originalMat.color) {
            originalColor = originalMat.color as THREE.Color;
          }
        }
        
        // Create a unique shader material for each mesh with its original texture
        const meshShader = createMultiSurfaceMaterial({
          floorColor: floorMat?.color,
          floorTexture: floorMat ? getTexture(floorMat) : undefined,
          floorTextureScale: floorMat?.textureSizeInches,
          applyFloor: !!floorMat,
          
          wallColor: wallMat?.color,
          wallTexture: wallMat ? getTexture(wallMat) : undefined,
          wallTextureScale: wallMat?.textureSizeInches,
          applyWall: !!wallMat,
          
          ceilingColor: ceilingMat?.color,
          ceilingTexture: ceilingMat ? getTexture(ceilingMat) : undefined,
          ceilingTextureScale: ceilingMat?.textureSizeInches,
          applyCeiling: !!ceilingMat,
          
          // Pass original texture for preserving non-renovated areas
          originalMap,
          originalColor,
          
          calibrationScale,
        });
        
        mesh.material = meshShader;
      });
      
      // Calculate costs
      const areas = estimateSurfaceAreas(meshGroup);
      
      const costItems: RenovationCostEstimate[] = [];
      
      if (floorMat && areas.floorArea > 0) {
        costItems.push(calculateRenovationCost(floorMat, areas.floorArea, calibrationScale));
      }
      if (wallMat && areas.wallArea > 0) {
        costItems.push(calculateRenovationCost(wallMat, areas.wallArea, calibrationScale));
      }
      if (ceilingMat && areas.ceilingArea > 0) {
        costItems.push(calculateRenovationCost(ceilingMat, areas.ceilingArea, calibrationScale));
      }
      
      // Aggregate costs
      const summary: RenovationCostSummary = {
        items: costItems,
        totalMaterialCost: costItems.reduce((sum, item) => sum + item.materialCost, 0),
        totalLaborCost: costItems.reduce((sum, item) => sum + item.laborCost, 0),
        grandTotal: costItems.reduce((sum, item) => sum + item.totalCost, 0),
        estimatedValueIncrease: costItems.reduce((sum, item) => sum + item.estimatedValueIncrease, 0),
        overallROI: 0,
      };
      
      if (summary.grandTotal > 0) {
        summary.overallROI = summary.estimatedValueIncrease / summary.grandTotal;
      }
      
      // console.log('[RenovationTexture] Cost summary:', summary);
      onCostCalculated?.(summary);
      hasAppliedRef.current = true;
      
    } else if (hasAppliedRef.current) {
      // Restore original materials
      console.log('[RenovationTexture] Restoring original materials...');
      
      originalMaterialsRef.current.forEach((original, mesh) => {
        mesh.material = original;
      });
      
      hasAppliedRef.current = false;
    }
  }, [meshGroup, isPreviewMode, selectedMaterials, calibrationScale, getTexture, onCostCalculated]);
  
  // Cleanup on unmount
  useEffect(() => {
    return () => {
      // Restore all materials
      originalMaterialsRef.current.forEach((original, mesh) => {
        if (mesh.material !== original) {
          mesh.material = original;
        }
      });
      originalMaterialsRef.current.clear();
      
      // Dispose shader material
      if (shaderMaterialRef.current) {
        shaderMaterialRef.current.dispose();
        shaderMaterialRef.current = null;
      }
      
      // Dispose textures
      textureCache.current.forEach((texture) => {
        texture.dispose();
      });
      textureCache.current.clear();
    };
  }, []);
  
  // Calculate label data - must be before any returns (React hooks rule)
  const labelData = useMemo(() => {
    if (!isPreviewMode || !meshGroup) return [];
    
    const labels: Array<{ type: string; materialName: string; color: string }> = [];
    
    if (selectedMaterials.flooringId) {
      const mat = getMaterialById(selectedMaterials.flooringId);
      if (mat) {
        labels.push({ type: 'Floor', materialName: mat.name, color: 'from-amber-600 to-orange-600' });
      }
    }
    if (selectedMaterials.wallId) {
      const mat = getMaterialById(selectedMaterials.wallId);
      if (mat) {
        labels.push({ type: 'Walls', materialName: mat.name, color: 'from-blue-600 to-indigo-600' });
      }
    }
    if (selectedMaterials.ceilingId) {
      const mat = getMaterialById(selectedMaterials.ceilingId);
      if (mat) {
        labels.push({ type: 'Ceiling', materialName: mat.name, color: 'from-purple-600 to-pink-600' });
      }
    }
    
    return labels;
  }, [isPreviewMode, meshGroup, selectedMaterials]);
  
  // Don't render anything if not in preview mode
  if (!isPreviewMode || labelData.length === 0) {
    return null;
  }
  
  // Render a fixed overlay in the corner showing applied materials
  return (
    <Html
      position={[0, 0, 0]}
      center
      style={{ 
        position: 'fixed',
        bottom: '20px',
        left: '20px',
        pointerEvents: 'none',
      }}
      calculatePosition={() => [20, window.innerHeight - 20, 0]}
    >
      <div className="bg-gray-900/90 backdrop-blur-sm rounded-lg p-3 border border-gray-700 shadow-xl">
        <div className="text-xs text-gray-400 uppercase mb-2">Applied Materials</div>
        <div className="space-y-1">
          {labelData.map((label, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full bg-gradient-to-r ${label.color}`}></span>
              <span className="text-white text-sm font-medium">{label.type}:</span>
              <span className="text-gray-300 text-sm">{label.materialName}</span>
            </div>
          ))}
        </div>
      </div>
    </Html>
  );
}

// ============================================================================
// Exports
// ============================================================================

export { 
  FLOORING_MATERIALS, 
  WALL_MATERIALS, 
  CEILING_MATERIALS,
  getMaterialById,
  type RenovationMaterial,
};

export default RenovationTextureSystem;
