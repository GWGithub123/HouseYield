/**
 * PhotogrammetryViewer Component
 * 
 * Interactive 3D viewer for photogrammetry scans using Three.js.
 * Features:
 * - GLB mesh loading and display
 * - Orbit controls for free navigation
 * - Viewpoint navigation (click arrows to move)
 * - Click-to-measure tools
 * - Room dimension display
 * - AI-powered renovation detection with 3D markers
 * - ROI estimates and cost breakdowns
 * - Add to contractor marketplace
 * - AR preview of renovations
 */

import { useRef, useState, useEffect, Suspense, useCallback, useMemo } from 'react';
import { Canvas, useThree, useFrame, useLoader } from '@react-three/fiber';
import { 
  OrbitControls, 
  useGLTF, 
  Html, 
  PerspectiveCamera,
  useProgress,
  TransformControls,
} from '@react-three/drei';
import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import type { NavigationGraph, Viewpoint } from '../types/photogrammetry';

// Renovation detection imports
import type { 
  DetectedRenovation, 
  RenovationDetectionState,
  ScanMetadata 
} from '../types/renovationDetection';
import { createInitialDetectionState } from '../types/renovationDetection';
import { RenovationOverlay } from './RenovationMarkers3D';
import { RenovationDetailsModal } from './RenovationDetailsModal';
import { AddToMarketplaceModal } from './AddToMarketplaceModal';
import { ARRenovationPreview } from './ARRenovationPreview';
// RenovationMeshOverlay is deprecated - now using RenovationTextureSystem
import { 
  RenovationTextureSystem, 
  type RenovationSelection,
  type RenovationCostSummary
} from './RenovationTextureSystem';
import { RenovationMaterialPicker } from './RenovationMaterialPicker';
import { MeshEditorPanel, useMeasuredHoleCutter } from './MeshEditorPanel';
import { MeasuredHoleCutterOverlay } from './MeasuredHoleCutter';
import { MeshyRetexturePanel } from './MeshyRetexturePanel';
import { ObjectGeneratorPanel } from './ObjectGeneratorPanel';

// AI Interior Scan - Vision AI analyzes room from inside and suggests renovations
import { useAIInteriorScan } from '../hooks/useAIInteriorScan';
import { AISuggestionMarkers, RenovationPreviewModal } from './AISuggestionMarkers';
import type { RenovationSuggestion } from '../services/aiInteriorScanService';
import { getRenovationOptionsForType } from '../services/aiInteriorScanService';

// AI texture generation
import {
  generateAITexture,
  loadTextureForThreeJS,
  type TextureGenerationRequest,
} from '../services/aiTextureGenerationService';
import {
  applyAITextureToSegment,
  segmentMesh,
  type MeshSegmentation,
} from '../services/meshSegmentationService';

// UV-based texture renovation (new approach - edits texture atlas directly)
import {
  performUVRenovation,
  extractMeshTexture,
  type UVRenovationRequest,
  type UVRenovationResult,
} from '../services/uvTextureRenovationService';

// Pro renovation: Multi-view Gemini + OpenMVS retexturing (best quality)
import {
  performRenovationRetexturing,
  generateViewpointsForMesh,
  type RetexturingResult,
  type RenovationViewpoint,
} from '../services/renovationRetexturingService';

// Top-down floor renovation (new approach)
import {
  captureTopDownView,
  createFloorPlaneWithTexture,
  animateCameraToTopDown,
  removeFloorPlane,
} from '../services/topDownFloorService';

// Projective texture mapping - projects AI-generated texture from camera viewpoint onto 3D mesh
import {
  applyRenovatedTextureToMesh,
  removeProjectiveTexture,
} from '../services/projectiveTextureService';

// Mesh analysis for accurate overlay positioning
import { analyzeMesh, adjustRenovationsToMesh, type MeshAnalysis } from '../services/meshAnalysisService';

// Mesh calibration for accurate measurements
import { 
  autoCalibrateMesh, 
  manualCalibrate, 
  getCalibratedDistance,
  captureSceneImage,
  type CalibrationResult 
} from '../services/meshCalibrationService';

// ============================================================================
// Types
// ============================================================================

interface ViewerProps {
  scanId: string;
  meshUrl: string;
  mtlUrl?: string;
  textureUrl?: string;
  fileType?: 'glb' | 'obj';
  navigation?: NavigationGraph;
  onMeasure?: (measurement: Measurement) => void;
  onClose?: () => void;
  initialViewpoint?: string;
  mode?: 'orbit' | 'walkthrough';
  showDimensions?: boolean;
  className?: string;
  // Renovation detection props
  renovationDetectionState?: RenovationDetectionState;
  onRenovationSelect?: (renovation: DetectedRenovation | null) => void;
  onAddToMarketplace?: (renovation: DetectedRenovation) => void;
  onARPreview?: (renovation: DetectedRenovation) => void;
  scanMetadata?: ScanMetadata;
  showRenovationMarkers?: boolean;
}

interface Measurement {
  id: string;
  type: 'distance' | 'area';
  points: THREE.Vector3[];
  value: number;
  unit: string;
}

interface ViewerState {
  mode: 'orbit' | 'walkthrough' | 'firstPerson';
  currentViewpoint: string | null;
  measurements: Measurement[];
  measuringMode: boolean;
  pendingPoints: THREE.Vector3[];
}

// Captured viewpoint for manual Pro renovation workflow
interface CapturedViewpoint {
  id: string;
  position: THREE.Vector3;
  target: THREE.Vector3;
  up: THREE.Vector3;
  fov: number;
  imageDataUrl: string;
  timestamp: number;
}

// ============================================================================
// Loading Component
// ============================================================================

function Loader() {
  const { progress } = useProgress();
  
  return (
    <Html center>
      <div className="flex flex-col items-center gap-2 text-white">
        <div className="w-48 h-2 bg-gray-700 rounded-full overflow-hidden">
          <div 
            className="h-full bg-blue-500 transition-all duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
        <span className="text-sm">{progress.toFixed(0)}% loaded</span>
      </div>
    </Html>
  );
}

// ============================================================================
// Placed Object Interface and Component
// ============================================================================

interface PlacedObjectData {
  id: string;
  url: string;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  name: string;
}

// Component to render a placed GLB object in the scene
function PlacedObject({ 
  data, 
  isSelected, 
  onSelect,
  onPositionChange,
  onRotationChange,
  onScaleChange,
  transformMode,
  onTransformEnd,
}: { 
  data: PlacedObjectData;
  isSelected: boolean;
  onSelect: () => void;
  onPositionChange?: (position: [number, number, number]) => void;
  onRotationChange?: (rotation: [number, number, number]) => void;
  onScaleChange?: (scale: [number, number, number]) => void;
  transformMode?: 'translate' | 'rotate' | 'scale';
  onTransformEnd?: () => void;
}) {
  const { scene } = useGLTF(data.url);
  const groupRef = useRef<THREE.Group>(null!);
  
  // Clone the scene so multiple instances don't conflict
  const clonedScene = useMemo(() => scene.clone(), [scene]);
  
  useEffect(() => {
    if (groupRef.current) {
      // Auto-scale to reasonable size if too big or too small
      const box = new THREE.Box3().setFromObject(groupRef.current);
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      
      if (maxDim > 5) {
        const targetScale = 2 / maxDim;
        groupRef.current.scale.setScalar(targetScale);
        console.log(`[PlacedObject] Scaled down from ${maxDim.toFixed(2)} to fit`);
      } else if (maxDim < 0.1) {
        const targetScale = 1 / maxDim;
        groupRef.current.scale.setScalar(targetScale);
        console.log(`[PlacedObject] Scaled up from ${maxDim.toFixed(2)} to be visible`);
      }
    }
  }, [clonedScene]);

  // Handle transform changes from TransformControls
  const handleTransformChange = useCallback(() => {
    if (!groupRef.current) return;
    
    const pos = groupRef.current.position;
    const rot = groupRef.current.rotation;
    const scl = groupRef.current.scale;
    
    onPositionChange?.([pos.x, pos.y, pos.z]);
    onRotationChange?.([rot.x, rot.y, rot.z]);
    onScaleChange?.([scl.x, scl.y, scl.z]);
  }, [onPositionChange, onRotationChange, onScaleChange]);
  
  return (
    <>
      <group
        ref={groupRef}
        position={data.position}
        rotation={data.rotation}
        scale={data.scale}
        onClick={(e) => {
          e.stopPropagation();
          onSelect();
        }}
      >
        <primitive object={clonedScene} />
        {/* Selection indicator */}
        {isSelected && !transformMode && (
          <mesh>
            <boxGeometry args={[0.5, 0.5, 0.5]} />
            <meshBasicMaterial color="#00ff00" wireframe transparent opacity={0.5} />
          </mesh>
        )}
      </group>
      
      {/* Transform controls when selected */}
      {isSelected && transformMode && groupRef.current && (
        <TransformControls
          object={groupRef.current}
          mode={transformMode}
          onObjectChange={handleTransformChange}
          onMouseUp={() => onTransformEnd?.()}
        />
      )}
    </>
  );
}

// ============================================================================
// Mesh Component
// ============================================================================

interface MeshDisplayProps {
  url: string;
  mtlUrl?: string;
  textureUrl?: string;
  fileType?: 'glb' | 'obj';
  onClick?: (point: THREE.Vector3, normal: THREE.Vector3) => void;
  onPointerMove?: (point: THREE.Vector3, normal: THREE.Vector3) => void;
  rotation?: [number, number, number];
  onMeshLoaded?: (meshGroup: THREE.Group) => void;
}

// Separate components for each file type to avoid conditional hooks
function GLBMesh({ url, onClick, onPointerMove, meshRef, onMeshLoaded }: { 
  url: string; 
  onClick?: (point: THREE.Vector3, normal: THREE.Vector3) => void;
  onPointerMove?: (point: THREE.Vector3, normal: THREE.Vector3) => void;
  meshRef: React.RefObject<THREE.Group>;
  onMeshLoaded?: (meshGroup: THREE.Group) => void;
}) {
  const { scene } = useGLTF(url);
  const { raycaster, mouse, camera } = useThree();
  
  useEffect(() => {
    if (meshRef.current) {
      console.log('[GLBMesh] Starting mesh setup...');
      
      const box = new THREE.Box3().setFromObject(meshRef.current);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      
      console.log('[GLBMesh] Original bounds:', {
        min: box.min.toArray(),
        max: box.max.toArray(),
        center: center.toArray(),
        size: size.toArray(),
      });
      
      // Center the mesh
      meshRef.current.position.sub(center);
      console.log('[GLBMesh] New mesh position (should center it):', meshRef.current.position.toArray());
      
      // Scale if too large
      const maxDim = Math.max(size.x, size.y, size.z);
      if (maxDim > 20) {
        const scale = 20 / maxDim;
        meshRef.current.scale.setScalar(scale);
        console.log('[GLBMesh] Applied scale:', scale);
      }
      
      // Convert all materials to MeshBasicMaterial so they don't need lighting
      meshRef.current.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          const oldMaterial = child.material as THREE.MeshStandardMaterial;
          if (oldMaterial.map) {
            // Has texture - use it
            child.material = new THREE.MeshBasicMaterial({
              map: oldMaterial.map,
              side: THREE.DoubleSide,
            });
            console.log('[GLBMesh] Converted to MeshBasicMaterial with texture');
          } else if (child.geometry.attributes.color) {
            // Has vertex colors
            child.material = new THREE.MeshBasicMaterial({
              vertexColors: true,
              side: THREE.DoubleSide,
            });
            console.log('[GLBMesh] Converted to MeshBasicMaterial with vertex colors');
          } else {
            // Fallback - use diffuse color or white
            child.material = new THREE.MeshBasicMaterial({
              color: oldMaterial.color || 0xcccccc,
              side: THREE.DoubleSide,
            });
            console.log('[GLBMesh] Converted to MeshBasicMaterial with color');
          }
        }
      });
      
      // Update world matrix to ensure bounds calculations are accurate
      meshRef.current.updateMatrixWorld(true);
      
      // Notify parent that mesh is loaded and ready for analysis
      // Pass the centered/scaled mesh and also the offset that was applied
      if (onMeshLoaded) {
        console.log('[GLBMesh] Mesh centered at:', meshRef.current.position.toArray());
        console.log('[GLBMesh] Mesh scale:', meshRef.current.scale.toArray());
        onMeshLoaded(meshRef.current);
      }
    }
  }, [scene, meshRef, onMeshLoaded]);
  
  const handleClick = useCallback((_event: THREE.Event) => {
    if (!onClick || !meshRef.current) return;
    
    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObject(meshRef.current, true);
    
    if (intersects.length > 0) {
      const hit = intersects[0];
      onClick(hit.point, hit.face?.normal || new THREE.Vector3(0, 1, 0));
    }
  }, [onClick, raycaster, mouse, camera, meshRef]);
  
  const handlePointerMove = useCallback((_event: THREE.Event) => {
    if (!onPointerMove || !meshRef.current) return;
    
    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObject(meshRef.current, true);
    
    if (intersects.length > 0) {
      const hit = intersects[0];
      onPointerMove(hit.point, hit.face?.normal || new THREE.Vector3(0, 1, 0));
    }
  }, [onPointerMove, raycaster, mouse, camera, meshRef]);
  
  return (
    <group ref={meshRef} onClick={handleClick} onPointerMove={handlePointerMove}>
      <primitive object={scene} />
    </group>
  );
}

function OBJMesh({ url, mtlUrl, onClick, onPointerMove, meshRef, onMeshLoaded }: { url: string; mtlUrl?: string; onClick?: (point: THREE.Vector3, normal: THREE.Vector3) => void; onPointerMove?: (point: THREE.Vector3, normal: THREE.Vector3) => void; meshRef: React.RefObject<THREE.Group>; onMeshLoaded?: (meshGroup: THREE.Group) => void }) {
  const { raycaster, mouse, camera } = useThree();
  const [obj, setObj] = useState<THREE.Group | null>(null);
  const [loading, setLoading] = useState(true);
  
  useEffect(() => {
    let mounted = true;
    
    const loadModel = async () => {
      try {
        console.log('[OBJMesh] Loading model from:', url);
        
        // For edited meshes, derive the MTL URL from the OBJ URL
        let effectiveMtlUrl = mtlUrl;
        if (url.includes('/edited-meshes/')) {
          effectiveMtlUrl = url.replace('.obj', '.mtl');
          console.log('[OBJMesh] Using derived MTL for edited mesh:', effectiveMtlUrl);
        }
        console.log('[OBJMesh] MTL path:', effectiveMtlUrl);
        
        const objLoader = new OBJLoader();
        const basePath = url.substring(0, url.lastIndexOf('/') + 1);
        console.log('[OBJMesh] Base path for textures:', basePath);
        
        // Load MTL first if provided
        if (effectiveMtlUrl) {
          console.log('[OBJMesh] Loading MTL...');
          const mtlLoader = new MTLLoader();
          mtlLoader.setResourcePath(basePath);
          
          const materials = await new Promise<any>((resolve, reject) => {
            mtlLoader.load(
              effectiveMtlUrl,
              (mtl) => {
                console.log('[OBJMesh] MTL loaded successfully');
                resolve(mtl);
              },
              undefined,
              (error) => {
                console.error('[OBJMesh] MTL load error:', error);
                reject(error);
              }
            );
          });
          
          materials.preload();
          objLoader.setMaterials(materials);
        }
        
        // Load OBJ
        console.log('[OBJMesh] Loading OBJ...');
        const loadedObj = await new Promise<THREE.Group>((resolve, reject) => {
          objLoader.load(
            url,
            (obj) => {
              console.log('[OBJMesh] OBJ loaded successfully:', obj);
              resolve(obj);
            },
            undefined,
            (error) => {
              console.error('[OBJMesh] OBJ load error:', error);
              reject(error);
            }
          );
        });
        
        if (mounted) {
          setObj(loadedObj);
          setLoading(false);
        }
      } catch (error) {
        console.error('[OBJMesh] Error loading OBJ model:', error);
        if (mounted) {
          setLoading(false);
        }
      }
    };
    
    loadModel();
    
    return () => {
      mounted = false;
    };
  }, [url, mtlUrl]);
  
  useEffect(() => {
    if (obj) {
      // Calculate bounding box from obj directly (not meshRef which may not have it yet)
      const box = new THREE.Box3().setFromObject(obj);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      
      console.log('[OBJMesh] Original model bounding box:', {
        center: { x: center.x.toFixed(2), y: center.y.toFixed(2), z: center.z.toFixed(2) },
        size: { x: size.x.toFixed(2), y: size.y.toFixed(2), z: size.z.toFixed(2) }
      });
      
      // CENTER THE GEOMETRY VERTICES directly
      obj.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          const mesh = child as THREE.Mesh;
          
          // Step 1: Translate geometry to center at origin
          mesh.geometry.translate(-center.x, -center.y, -center.z);
          
          // Step 2: FLIP right-side up (rotate 180° around X axis)
          mesh.geometry.rotateX(Math.PI);
          
          // Step 3: Recalculate center after rotation and re-center
          mesh.geometry.computeBoundingBox();
          const newCenter = new THREE.Vector3();
          mesh.geometry.boundingBox!.getCenter(newCenter);
          mesh.geometry.translate(-newCenter.x, 0, -newCenter.z); // Keep Y, recenter X/Z
          
          // Step 4: Put floor at Y=0
          mesh.geometry.computeBoundingBox();
          const floorY = mesh.geometry.boundingBox!.min.y;
          mesh.geometry.translate(0, -floorY, 0);
          
          mesh.geometry.computeBoundingBox();
          const finalCenter = new THREE.Vector3();
          mesh.geometry.boundingBox!.getCenter(finalCenter);
          console.log('[OBJMesh] Final mesh center:', finalCenter);
          console.log('[OBJMesh] Final mesh bbox:', mesh.geometry.boundingBox);
        }
      });
      
      // Reset obj transforms
      obj.position.set(0, 0, 0);
      obj.rotation.set(0, 0, 0);
      obj.scale.set(1, 1, 1);
      
      console.log('[OBJMesh] Mesh centered at origin, floor at Y=0');
      
      const maxDim = Math.max(size.x, size.y, size.z);
      console.log('[OBJMesh] Max dimension:', maxDim);
      
      if (maxDim > 20) {
        const scale = 20 / maxDim;
        console.log('[OBJMesh] Scaling model by:', scale);
        obj.scale.setScalar(scale);
      }
      
      // Debug: Log materials and make sure they're double-sided
      // Apply directly to obj since meshRef might not have it as child yet
      let meshCount = 0;
      obj.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          const mesh = child as THREE.Mesh;
          meshCount++;
          console.log('[OBJMesh] Found mesh #' + meshCount + ':', mesh.name);
          console.log('[OBJMesh] Geometry vertices:', mesh.geometry?.attributes?.position?.count);
          console.log('[OBJMesh] Geometry has UVs:', !!mesh.geometry?.attributes?.uv);
          if (mesh.geometry?.attributes?.uv) {
            console.log('[OBJMesh] UV count:', mesh.geometry.attributes.uv.count);
          }
          
          // Make materials double-sided so we can see both sides
          if (Array.isArray(mesh.material)) {
            mesh.material.forEach((mat, i) => {
              mat.side = THREE.DoubleSide;
              mat.needsUpdate = true;
              console.log('[OBJMesh] Material[' + i + ']:', mat.type);
              if ((mat as any).map) {
                console.log('[OBJMesh] Material[' + i + '] has texture map:', (mat as any).map.image?.src);
              } else {
                console.log('[OBJMesh] Material[' + i + '] has NO texture map');
              }
            });
          } else if (mesh.material) {
            const originalMat = mesh.material as any;
            const hasUv = !!mesh.geometry?.attributes?.uv;
            const hasVertexColors = !!mesh.geometry?.attributes?.color;
            console.log('[OBJMesh] Material type:', originalMat.type);
            console.log('[OBJMesh] Original material map:', originalMat.map);
            console.log('[OBJMesh] Original material map image:', originalMat.map?.image);
            console.log('[OBJMesh] Geometry has usable UVs:', hasUv);
            console.log('[OBJMesh] Geometry has vertex colors:', hasVertexColors);
            
            if (originalMat.map && hasUv) {
              console.log('[OBJMesh] Material has texture map:', originalMat.map.image?.src || originalMat.map);
              
              // Check if the texture image is actually loaded
              const texture = originalMat.map;
              console.log('[OBJMesh] Texture image loaded:', !!texture.image);
              console.log('[OBJMesh] Texture flipY:', texture.flipY);
              
              // Store original texture in userData for AI texture modification
              mesh.userData.originalTextureForAI = texture;
              mesh.userData.originalMaterialForAI = originalMat;
              console.log('[OBJMesh] Stored original texture in userData for AI modification');
              
              // Convert to MeshBasicMaterial so texture renders at full brightness
              // without depending on scene lighting (MeshPhongMaterial makes it invisible/dark)
              texture.colorSpace = THREE.SRGBColorSpace;
              texture.needsUpdate = true;
              
              mesh.material = new THREE.MeshBasicMaterial({
                map: texture,
                side: THREE.DoubleSide,
              });
              
              console.log('[OBJMesh] Converted MeshPhongMaterial → MeshBasicMaterial with texture');
            } else if (hasVertexColors) {
              console.log('[OBJMesh] Using vertex colors because texture UVs are unavailable');
              mesh.material = new THREE.MeshBasicMaterial({
                vertexColors: true,
                side: THREE.DoubleSide,
              });
            } else {
              console.log('[OBJMesh] Material has NO texture - using fallback color');
              mesh.material = new THREE.MeshBasicMaterial({
                color: originalMat.color || 0x888888,
                side: THREE.DoubleSide
              });
            }
          }
          
          // Ensure geometry is computed properly
          mesh.geometry.computeVertexNormals();
          mesh.geometry.computeBoundingSphere();
        }
      });
      console.log('[OBJMesh] Total meshes found:', meshCount);
      
      console.log('[OBJMesh] Model positioned and ready to render');
      
      // Notify parent that mesh is loaded and ready for analysis
      if (onMeshLoaded && meshRef.current) {
        // Update world matrix to ensure bounds calculations are accurate
        meshRef.current.updateMatrixWorld(true);
        console.log('[OBJMesh] Calling onMeshLoaded callback');
        onMeshLoaded(meshRef.current);
      }
    }
  }, [obj, onMeshLoaded, meshRef]);
  
  const handleClick = useCallback((_event: THREE.Event) => {
    if (!onClick || !meshRef.current) return;
    
    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObject(meshRef.current, true);
    
    if (intersects.length > 0) {
      const hit = intersects[0];
      onClick(hit.point, hit.face?.normal || new THREE.Vector3(0, 1, 0));
    }
  }, [onClick, raycaster, mouse, camera, meshRef]);
  
  const handlePointerMove = useCallback((_event: THREE.Event) => {
    if (!onPointerMove || !meshRef.current) return;
    
    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObject(meshRef.current, true);
    
    if (intersects.length > 0) {
      const hit = intersects[0];
      onPointerMove(hit.point, hit.face?.normal || new THREE.Vector3(0, 1, 0));
    }
  }, [onPointerMove, raycaster, mouse, camera, meshRef]);
  
  if (loading || !obj) {
    return (
      <Html center>
        <div className="text-white">Loading model...</div>
      </Html>
    );
  }
  
  // Removed per-frame log to prevent console flooding
  
  return (
    <group ref={meshRef} onClick={handleClick} onPointerMove={handlePointerMove}>
      <primitive object={obj} />
    </group>
  );
}

function MeshDisplay({ url, mtlUrl, textureUrl, fileType = 'glb', onClick, onPointerMove, rotation = [0, 0, 0], onMeshLoaded }: MeshDisplayProps) {
  const meshRef = useRef<THREE.Group>(null);
  
  // Detect actual file type from URL - this is important when Meshy returns GLB files
  // even though the original scan might have been OBJ
  const detectFileType = (urlString: string): 'glb' | 'obj' => {
    const lowerUrl = urlString.toLowerCase();
    
    // Check for GLB/GLTF formats (including data URIs, blob URLs, and Meshy retextured files)
    if (lowerUrl.includes('.glb') || lowerUrl.includes('.gltf') || 
        lowerUrl.includes('format=glb') || lowerUrl.includes('format=gltf') ||
        lowerUrl.includes('meshy') || lowerUrl.includes('retextured-meshes') ||
        lowerUrl.includes('retextured_')) {
      return 'glb';
    }
    // Check for OBJ format
    if (lowerUrl.includes('.obj')) {
      return 'obj';
    }
    // Fall back to provided fileType
    return fileType;
  };
  
  const actualFileType = detectFileType(url);
  
  // Log when file type detection overrides the prop
  if (actualFileType !== fileType) {
    console.log(`[MeshDisplay] Detected file type '${actualFileType}' from URL (overriding prop '${fileType}')`);
  }
  
  return (
    <group rotation={rotation}>
      {actualFileType === 'glb' && <GLBMesh url={url} onClick={onClick} onPointerMove={onPointerMove} meshRef={meshRef} onMeshLoaded={onMeshLoaded} />}
      {actualFileType === 'obj' && <OBJMesh url={url} mtlUrl={mtlUrl} onClick={onClick} onPointerMove={onPointerMove} meshRef={meshRef} onMeshLoaded={onMeshLoaded} />}
    </group>
  );
}

// ============================================================================
// Viewpoint Navigation
// ============================================================================

interface ViewpointNavigationProps {
  navigation: NavigationGraph;
  currentViewpoint: string;
  onNavigate: (viewpointId: string) => void;
}

function ViewpointNavigation({ navigation, currentViewpoint, onNavigate }: ViewpointNavigationProps) {
  const current = navigation.viewpointMap.get(currentViewpoint);
  if (!current) return null;
  
  // Get connected viewpoints
  const connections = navigation.edges.filter(
    edge => edge.from === currentViewpoint && edge.walkable
  );
  
  return (
    <group position={[current.position.x, current.position.y + 0.1, current.position.z]}>
      {connections.map((edge) => {
        const target = navigation.viewpointMap.get(edge.to);
        if (!target) return null;
        
        const direction = new THREE.Vector3(
          target.position.x - current.position.x,
          0,
          target.position.z - current.position.z
        ).normalize();
        
        const angle = Math.atan2(direction.x, direction.z);
        
        return (
          <group key={edge.to} rotation={[0, angle, 0]}>
            <mesh
              position={[0, 0.5, 1.5]}
              onClick={() => onNavigate(edge.to)}
            >
              {/* Arrow shape */}
              <coneGeometry args={[0.3, 0.6, 4]} />
              <meshStandardMaterial 
                color="#3b82f6" 
                transparent 
                opacity={0.8}
                emissive="#3b82f6"
                emissiveIntensity={0.3}
              />
            </mesh>
            
            {/* Distance label */}
            <Html position={[0, 0.8, 1.5]} center>
              <div className="bg-black/70 text-white text-xs px-2 py-1 rounded whitespace-nowrap">
                {edge.distance.toFixed(1)}m
              </div>
            </Html>
          </group>
        );
      })}
    </group>
  );
}

// ============================================================================
// Measurement Markers
// ============================================================================

interface MeasurementMarkersProps {
  measurements: Measurement[];
  pendingPoints: THREE.Vector3[];
}

function MeasurementMarkers({ measurements, pendingPoints }: MeasurementMarkersProps) {
  return (
    <group>
      {/* Completed measurements */}
      {measurements.map((measurement) => (
        <group key={measurement.id}>
          {measurement.points.map((point, i) => (
            <mesh key={i} position={point}>
              <sphereGeometry args={[0.05]} />
              <meshStandardMaterial color="#ef4444" />
            </mesh>
          ))}
          
          {measurement.type === 'distance' && measurement.points.length === 2 && (
            <>
              <line>
                <bufferGeometry>
                  <bufferAttribute
                    attach="attributes-position"
                    args={[
                      new Float32Array([
                        ...measurement.points[0].toArray(),
                        ...measurement.points[1].toArray(),
                      ]),
                      3
                    ]}
                  />
                </bufferGeometry>
                <lineBasicMaterial color="#ef4444" linewidth={2} />
              </line>
              
              {/* Distance label */}
              <Html
                position={measurement.points[0].clone().add(measurement.points[1]).multiplyScalar(0.5)}
                center
              >
                <div className="bg-red-600 text-white text-sm px-2 py-1 rounded font-medium">
                  {measurement.value.toFixed(2)} {measurement.unit}
                </div>
              </Html>
            </>
          )}
        </group>
      ))}
      
      {/* Pending points */}
      {pendingPoints.map((point, i) => (
        <mesh key={`pending-${i}`} position={point}>
          <sphereGeometry args={[0.05]} />
          <meshStandardMaterial color="#f59e0b" />
        </mesh>
      ))}
    </group>
  );
}

// ============================================================================
// Scene Capture Component for Auto-Calibration
// ============================================================================

interface SceneCaptureProps {
  onCapture: (imageData: string, gl: THREE.WebGLRenderer, camera: THREE.Camera, scene: THREE.Scene) => void;
  triggerCapture: boolean;
  onCaptureComplete: () => void;
}

function SceneCapture({ onCapture, triggerCapture, onCaptureComplete }: SceneCaptureProps) {
  const { gl, camera, scene } = useThree();
  
  useEffect(() => {
    if (triggerCapture) {
      console.log('[SceneCapture] 🎬 Starting scene capture for auto-calibration');
      console.log('[SceneCapture] Camera position:', camera.position.toArray());
      console.log('[SceneCapture] Renderer size:', { width: gl.domElement.width, height: gl.domElement.height });
      
      // Render the scene to capture current view
      gl.render(scene, camera);
      
      // Capture as base64 image
      const imageData = gl.domElement.toDataURL('image/jpeg', 0.9);
      const imageSizeKB = Math.round(imageData.length / 1024);
      
      console.log('[SceneCapture] ✓ Scene image captured successfully');
      console.log('[SceneCapture] Image size:', imageSizeKB, 'KB');
      console.log('[SceneCapture] Image preview:', imageData.substring(0, 50) + '...');
      
      onCapture(imageData, gl, camera, scene);
      onCaptureComplete();
    }
  }, [triggerCapture, gl, camera, scene, onCapture, onCaptureComplete]);
  
  return null;
}

// ============================================================================
// Ref Sync Component - Populates external refs from inside Canvas
// Allows external functions to access camera, controls, renderer, scene
// ============================================================================

interface RefSyncProps {
  cameraRef: React.MutableRefObject<THREE.Camera | null>;
  rendererRef: React.MutableRefObject<THREE.WebGLRenderer | null>;
  sceneRef: React.MutableRefObject<THREE.Scene | null>;
  controlsRef: React.MutableRefObject<any>;
}

function RefSync({ cameraRef, rendererRef, sceneRef, controlsRef }: RefSyncProps) {
  const { gl, camera, scene } = useThree();
  
  useEffect(() => {
    cameraRef.current = camera;
    rendererRef.current = gl;
    sceneRef.current = scene;
  }, [camera, gl, scene, cameraRef, rendererRef, sceneRef]);
  
  return null;
}

// ============================================================================
// Top-Down Capture Component for AI Floor Renovation
// Moves camera to top-down view, captures, then restores
// ============================================================================

interface TopDownCaptureResult {
  imageData: string;
  bounds: { 
    minX: number; maxX: number; minZ: number; maxZ: number; 
    width: number; depth: number; centerX: number; centerZ: number; floorY: number;
  };
  orthoCamera: THREE.OrthographicCamera; // Return the camera for projection
}

interface TopDownCaptureProps {
  meshGroup: THREE.Group | null;
  trigger: boolean;
  onCapture: (result: TopDownCaptureResult) => void;
  onComplete: () => void;
}

function TopDownCapture({ meshGroup, trigger, onCapture, onComplete }: TopDownCaptureProps) {
  const { gl, camera, scene } = useThree();
  
  useEffect(() => {
    if (!trigger || !meshGroup) return;
    
    console.log('[TopDownCapture] 🎬 Starting top-down capture for projective texture...');
    
    // Calculate mesh bounds
    const box = new THREE.Box3().setFromObject(meshGroup);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    
    console.log('[TopDownCapture] Mesh bounds:', {
      center: center.toArray().map((v: number) => v.toFixed(2)),
      size: size.toArray().map((v: number) => v.toFixed(2)),
    });
    
    // Create a temporary orthographic camera for perfect top-down capture
    // This same camera will be used for projecting the texture back
    const viewSize = Math.max(size.x, size.z) * 1.1;
    const orthoCamera = new THREE.OrthographicCamera(
      -viewSize / 2,
      viewSize / 2,
      viewSize / 2,
      -viewSize / 2,
      0.1,
      size.y * 5
    );
    
    // Position camera directly above, looking straight down
    orthoCamera.position.set(center.x, box.max.y + size.y * 2, center.z);
    orthoCamera.up.set(0, 0, -1); // Z-axis is "up" in screen space for top-down
    orthoCamera.lookAt(center.x, center.y, center.z);
    orthoCamera.updateMatrixWorld(true);
    orthoCamera.updateProjectionMatrix();
    
    console.log('[TopDownCapture] Ortho camera at:', orthoCamera.position.toArray().map((v: number) => v.toFixed(2)));
    console.log('[TopDownCapture] Ortho camera looking at:', center.toArray().map((v: number) => v.toFixed(2)));
    
    // Render with orthographic camera
    gl.render(scene, orthoCamera);
    
    // Capture the image
    const imageData = gl.domElement.toDataURL('image/jpeg', 0.9);
    console.log('[TopDownCapture] ✓ Top-down image captured, size:', Math.round(imageData.length / 1024), 'KB');
    
    // Restore the view with original camera
    gl.render(scene, camera);
    
    // Call the callback with captured data AND the ortho camera
    onCapture({
      imageData,
      bounds: {
        minX: box.min.x,
        maxX: box.max.x,
        minZ: box.min.z,
        maxZ: box.max.z,
        width: size.x,
        depth: size.z,
        centerX: center.x,
        centerZ: center.z,
        floorY: box.min.y,
      },
      orthoCamera, // Return for projection
    });
    
    onComplete();
    
  }, [trigger, meshGroup, gl, camera, scene, onCapture, onComplete]);
  
  return null;
}

// ============================================================================
// Camera Controller
// ============================================================================

interface CameraControllerProps {
  mode: 'orbit' | 'walkthrough';
  viewpoint?: Viewpoint;
  onViewpointReached?: () => void;
}

function CameraController({ mode, viewpoint, onViewpointReached }: CameraControllerProps) {
  const { camera } = useThree();
  const targetPosition = useRef(new THREE.Vector3());
  const isAnimating = useRef(false);
  
  useEffect(() => {
    if (mode === 'walkthrough' && viewpoint) {
      targetPosition.current.set(
        viewpoint.position.x,
        viewpoint.position.y + 1.6, // Eye height
        viewpoint.position.z
      );
      isAnimating.current = true;
    }
  }, [mode, viewpoint]);
  
  useFrame(() => {
    if (isAnimating.current && mode === 'walkthrough') {
      const distance = camera.position.distanceTo(targetPosition.current);
      
      if (distance > 0.1) {
        camera.position.lerp(targetPosition.current, 0.05);
      } else {
        camera.position.copy(targetPosition.current);
        isAnimating.current = false;
        onViewpointReached?.();
      }
    }
  });
  
  return null;
}

// ============================================================================
// First Person Controls Component
// ============================================================================

interface FirstPersonControlsProps {
  enabled: boolean;
  moveSpeed?: number;
  lookSpeed?: number;
}

function FirstPersonControls({ enabled, moveSpeed = 0.1, lookSpeed = 0.002 }: FirstPersonControlsProps) {
  const { camera, gl } = useThree();
  const moveState = useRef({ forward: false, backward: false, left: false, right: false, up: false, down: false });
  const euler = useRef(new THREE.Euler(0, 0, 0, 'YXZ'));
  const isLooking = useRef(false);
  const lastMouse = useRef({ x: 0, y: 0 });
  
  useEffect(() => {
    if (!enabled) return;
    
    // Position camera at center, slightly above ground level
    camera.position.set(0, 1.6, 0); // Eye height
    camera.lookAt(0, 1.6, -5);
    
    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.code) {
        case 'KeyW': case 'ArrowUp': moveState.current.forward = true; break;
        case 'KeyS': case 'ArrowDown': moveState.current.backward = true; break;
        case 'KeyA': case 'ArrowLeft': moveState.current.left = true; break;
        case 'KeyD': case 'ArrowRight': moveState.current.right = true; break;
        case 'Space': moveState.current.up = true; e.preventDefault(); break;
        case 'ShiftLeft': case 'ShiftRight': moveState.current.down = true; break;
      }
    };
    
    const handleKeyUp = (e: KeyboardEvent) => {
      switch (e.code) {
        case 'KeyW': case 'ArrowUp': moveState.current.forward = false; break;
        case 'KeyS': case 'ArrowDown': moveState.current.backward = false; break;
        case 'KeyA': case 'ArrowLeft': moveState.current.left = false; break;
        case 'KeyD': case 'ArrowRight': moveState.current.right = false; break;
        case 'Space': moveState.current.up = false; break;
        case 'ShiftLeft': case 'ShiftRight': moveState.current.down = false; break;
      }
    };
    
    const handleMouseDown = (e: MouseEvent) => {
      if (e.button === 0) { // Left click
        isLooking.current = true;
        lastMouse.current = { x: e.clientX, y: e.clientY };
        gl.domElement.style.cursor = 'grabbing';
      }
    };
    
    const handleMouseMove = (e: MouseEvent) => {
      if (!isLooking.current) return;
      
      const deltaX = e.clientX - lastMouse.current.x;
      const deltaY = e.clientY - lastMouse.current.y;
      
      euler.current.setFromQuaternion(camera.quaternion);
      euler.current.y -= deltaX * lookSpeed;
      euler.current.x -= deltaY * lookSpeed;
      euler.current.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, euler.current.x));
      
      camera.quaternion.setFromEuler(euler.current);
      
      lastMouse.current = { x: e.clientX, y: e.clientY };
    };
    
    const handleMouseUp = () => {
      isLooking.current = false;
      gl.domElement.style.cursor = 'grab';
    };
    
    // Two-finger scroll for looking around
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      euler.current.setFromQuaternion(camera.quaternion);
      euler.current.y -= e.deltaX * lookSpeed * 0.5;
      euler.current.x -= e.deltaY * lookSpeed * 0.5;
      euler.current.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, euler.current.x));
      camera.quaternion.setFromEuler(euler.current);
    };
    
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    gl.domElement.addEventListener('mousedown', handleMouseDown);
    gl.domElement.addEventListener('mousemove', handleMouseMove);
    gl.domElement.addEventListener('mouseup', handleMouseUp);
    gl.domElement.addEventListener('mouseleave', handleMouseUp);
    gl.domElement.addEventListener('wheel', handleWheel, { passive: false });
    gl.domElement.style.cursor = 'grab';
    
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      gl.domElement.removeEventListener('mousedown', handleMouseDown);
      gl.domElement.removeEventListener('mousemove', handleMouseMove);
      gl.domElement.removeEventListener('mouseup', handleMouseUp);
      gl.domElement.removeEventListener('mouseleave', handleMouseUp);
      gl.domElement.removeEventListener('wheel', handleWheel);
      gl.domElement.style.cursor = 'auto';
    };
  }, [enabled, camera, gl, lookSpeed]);
  
  useFrame(() => {
    if (!enabled) return;
    
    const direction = new THREE.Vector3();
    const right = new THREE.Vector3();
    
    camera.getWorldDirection(direction);
    right.crossVectors(direction, camera.up).normalize();
    
    // Remove Y component for horizontal movement
    const forward = new THREE.Vector3(direction.x, 0, direction.z).normalize();
    const sideRight = new THREE.Vector3(right.x, 0, right.z).normalize();
    
    if (moveState.current.forward) camera.position.addScaledVector(forward, moveSpeed);
    if (moveState.current.backward) camera.position.addScaledVector(forward, -moveSpeed);
    if (moveState.current.left) camera.position.addScaledVector(sideRight, -moveSpeed);
    if (moveState.current.right) camera.position.addScaledVector(sideRight, moveSpeed);
    if (moveState.current.up) camera.position.y += moveSpeed;
    if (moveState.current.down) camera.position.y -= moveSpeed;
  });
  
  return null;
}

// ============================================================================
// Main Viewer Component
// ============================================================================

export function PhotogrammetryViewer({
  scanId,
  meshUrl,
  mtlUrl,
  textureUrl,
  fileType = 'glb',
  navigation,
  onMeasure,
  initialViewpoint,
  mode: initialMode = 'orbit',
  showDimensions: _showDimensions = true, // Reserved for dimension overlay
  className = '',
  // Renovation detection props
  renovationDetectionState,
  onRenovationSelect,
  onAddToMarketplace,
  onARPreview,
  scanMetadata,
  showRenovationMarkers = true,
}: ViewerProps) {
  const [state, setState] = useState<ViewerState>({
    mode: initialMode,
    currentViewpoint: initialViewpoint || (navigation?.viewpoints[0]?.id) || null,
    measurements: [],
    measuringMode: false,
    pendingPoints: [],
  });
  
  // Renovation detection local state
  const [selectedRenovation, setSelectedRenovation] = useState<DetectedRenovation | null>(null);
  const [showDetailsModal, setShowDetailsModal] = useState(false);
  const [showMarketplaceModal, setShowMarketplaceModal] = useState(false);
  const [showARPreview, setShowARPreview] = useState(false);
  const [hoveredRenovationId, setHoveredRenovationId] = useState<string | null>(null);
  
  // Mesh analysis state for accurate renovation overlay positioning
  const [meshAnalysis, setMeshAnalysis] = useState<MeshAnalysis | null>(null);
  const [adjustedRenovations, setAdjustedRenovations] = useState<DetectedRenovation[]>([]);
  
  // Calibration state for accurate real-world measurements
  const [calibration, setCalibration] = useState<CalibrationResult | null>(null);
  const [isCalibrating, setIsCalibrating] = useState(false);
  const [showCalibrationPanel, setShowCalibrationPanel] = useState(false);
  const [manualCalibrationMode, setManualCalibrationMode] = useState(false);
  const [manualCalibrationPoints, setManualCalibrationPoints] = useState<THREE.Vector3[]>([]);
  const [manualCalibrationDistance, setManualCalibrationDistance] = useState<string>('');
  const [triggerSceneCapture, setTriggerSceneCapture] = useState(false);
  const [autoCalibrationStatus, setAutoCalibrationStatus] = useState<string>('');
  
  // Model rotation state (in radians)
  const [modelRotation, setModelRotation] = useState<[number, number, number]>([0, 0, 0]);
  
  // Track if we're in model rotation mode (Shift key or two-finger)
  const [isRotatingModel, setIsRotatingModel] = useState(false);
  const lastMousePos = useRef<{ x: number; y: number } | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  
  // Store mesh group reference for RenovationPreviewSystem
  const meshGroupRef = useRef<THREE.Group | null>(null);
  
  // Refs for camera, controls, renderer, and scene - populated from inside Canvas
  const cameraRef = useRef<THREE.Camera | null>(null);
  const controlsRef = useRef<any>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  
  // Renovation preview panel state
  const [showRenovationPreview, setShowRenovationPreview] = useState(false);
  
  // Mesh Editor panel state
  const [showMeshEditor, setShowMeshEditor] = useState(false);
  const [showMeshyRetexture, setShowMeshyRetexture] = useState(false);
  const [showObjectGenerator, setShowObjectGenerator] = useState(false);
  const [placedObjects, setPlacedObjects] = useState<PlacedObjectData[]>([]);
  const [selectedObjectId, setSelectedObjectId] = useState<string | null>(null);
  const [transformMode, setTransformMode] = useState<'translate' | 'rotate' | 'scale'>('translate');
  const [currentMeshUrl, setCurrentMeshUrl] = useState<string | null>(null);
  const [openingPlacementMode, setOpeningPlacementMode] = useState<'door' | 'window' | null>(null);
  const [openingPreview, setOpeningPreview] = useState<THREE.Mesh | null>(null);
  const [placedPosition, setPlacedPosition] = useState<THREE.Vector3 | null>(null);
  const [placedNormal, setPlacedNormal] = useState<THREE.Vector3 | null>(null);
  
  // Measured hole cutter state
  const measuredHoleCutter = useMeasuredHoleCutter(calibration, meshGroupRef.current);
  
  // AI Interior Scan - Vision AI room analysis
  const aiInteriorScan = useAIInteriorScan();
  
  // Renovation texture system state (new material-based preview)
  const [showMaterialPicker, setShowMaterialPicker] = useState(false);
  const [selectedMaterials, setSelectedMaterials] = useState<RenovationSelection>({
    flooringId: null,
    wallId: null,
    ceilingId: null,
  });
  const [textureCostSummary, setTextureCostSummary] = useState<TextureCostSummary | null>(null);
  
  // AI texture generation state
  const [isGeneratingAITexture, setIsGeneratingAITexture] = useState(false);
  const [generatingAISurface, setGeneratingAISurface] = useState<'flooring' | 'wall' | 'ceiling' | null>(null);
  const [meshSegmentation, setMeshSegmentation] = useState<MeshSegmentation | null>(null);
  const [aiFloorOverlay, setAiFloorOverlay] = useState<THREE.Mesh | null>(null);
  const [aiRenovationPreview, setAiRenovationPreview] = useState<string | null>(null); // Data URL of AI-renovated room image
  const [showRenovationPreviewModal, setShowRenovationPreviewModal] = useState(false);
  const [currentRenovationMaterial, setCurrentRenovationMaterial] = useState<string | null>(null); // Track which material was used
  const [isApplyingTo3D, setIsApplyingTo3D] = useState(false); // Track if we're applying to 3D
  
  // Floor measurement state for AI Floor Overlay
  const [floorMeasurement, setFloorMeasurement] = useState<{
    width: number;
    depth: number;
    widthFeet?: number;
    depthFeet?: number;
    floorY: number;
    centerX: number;
    centerZ: number;
    floorPoints?: [number, number, number][];
  } | null>(null);
  
  // UV-based renovation state (new approach - edits texture atlas directly)
  const [useUVRenovation, setUseUVRenovation] = useState(true); // Default to new UV method
  type RenovationMethodType = 'triplanar' | 'pro' | 'uv' | 'tile';
  const [renovationMethod, setRenovationMethod] = useState<RenovationMethodType>('triplanar'); // Default to Triplanar (recommended)
  const [isRetexturing, setIsRetexturing] = useState(false);
  const [retexturingProgress, setRetexturingProgress] = useState<{ stage: string; progress: number } | null>(null);
  const [uvRenovationResult, setUVRenovationResult] = useState<UVRenovationResult | null>(null);
  const [originalMeshTexture, setOriginalMeshTexture] = useState<THREE.Texture | null>(null);
  const [meshSupportsUV, setMeshSupportsUV] = useState<boolean | null>(null); // null = not checked yet
  
  // Top-down capture state for AI floor renovation
  const [triggerTopDownCapture, setTriggerTopDownCapture] = useState(false);
  const [pendingFloorMaterial, setPendingFloorMaterial] = useState<{ name: string; description: string } | null>(null);
  const [capturedTopDownImage, setCapturedTopDownImage] = useState<string | null>(null);
  const [capturedFloorBounds, setCapturedFloorBounds] = useState<any>(null);
  
  // Projective texture state - stores the restore function to remove the projection
  const [projectiveTextureRestore, setProjectiveTextureRestore] = useState<(() => void) | null>(null);
  
  // Manual Viewpoint Capture for Pro Renovation
  const [capturedViewpoints, setCapturedViewpoints] = useState<CapturedViewpoint[]>([]);
  const [isCapturingViewpoints, setIsCapturingViewpoints] = useState(false);
  
  // Manual Room Image Capture for Enhanced Tile Renovation
  const [capturedRoomImageForTile, setCapturedRoomImageForTile] = useState<string | null>(null);
  const [capturedRoomCameraMatrix, setCapturedRoomCameraMatrix] = useState<THREE.Matrix4 | null>(null);
  const [capturedRoomProjectionMatrix, setCapturedRoomProjectionMatrix] = useState<THREE.Matrix4 | null>(null);

  // AI Floor Outline Visualization - GPT-4o Vision draws on the mesh
  const [aiFloorOutline, setAiFloorOutline] = useState<THREE.LineLoop | null>(null);
  const [aiFloorFill, setAiFloorFill] = useState<THREE.Mesh | null>(null);
  const [isAiOutlining, setIsAiOutlining] = useState(false);

  // ============================================================================
  // NEW: AI Floor Overlay - Top-Down Approach
  // 1. Automatically positions camera for top-down view
  // 2. Captures the mesh from above
  // 3. Sends to Gemini for AI floor renovation
  // 4. Projects the result onto a floor plane
  // This gives the best results because floors are horizontal!
  // ============================================================================
  
  // Handle top-down capture result - uses PROJECTIVE TEXTURE MAPPING
  // The orthoCamera is the same camera used for capture, so the projection will be perfect
  const handleTopDownCaptureResult = useCallback(async (
    result: TopDownCaptureResult
  ) => {
    const { imageData, bounds, orthoCamera } = result;
    
    if (!pendingFloorMaterial || !meshGroupRef.current) {
      console.error('[PhotogrammetryViewer] No pending floor material or mesh group');
      return;
    }
    
    console.log('[PhotogrammetryViewer] Top-down capture received, sending to Gemini...');
    console.log('[PhotogrammetryViewer] Will use projective texture from ortho camera for perfect floor mapping');
    
    const { name: materialName, description: materialDescription } = pendingFloorMaterial;
    
    try {
      // Remove any existing projective texture or floor plane
      removeProjectiveTexture(meshGroupRef.current);
      removeFloorPlane(meshGroupRef.current);
      
      // Build the renovation prompt
      let floorDescription = materialName;
      if (materialDescription) {
        floorDescription += `. ${materialDescription}`;
      }
      
      // Send to the renovation preview API (which uses Gemini image-to-image)
      const response = await fetch('/api/renovation-preview/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageData,
          renovationType: 'flooring',
          renovationOption: floorDescription,
          additionalPrompt: `This is a top-down orthographic view of a room. 
Replace ALL visible floor areas with ${floorDescription}. 
Keep all furniture and objects exactly the same - only change the floor surface.
The floor should fill all areas that are currently showing floor/carpet/ground.
Make the ${materialName} look realistic with proper wood grain direction, consistent lighting, and natural variation.
This is a bird's eye view, so show the flooring pattern as it would appear from directly above.`,
        }),
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to generate floor renovation');
      }
      
      const apiResult = await response.json();
      console.log('[PhotogrammetryViewer] Gemini renovation complete!');
      
      if (!apiResult.success || !apiResult.imageUrl) {
        throw new Error(apiResult.error || 'Renovation generation failed');
      }
      
      // Load the renovated image as a texture
      const textureLoader = new THREE.TextureLoader();
      const renovatedTexture = await new Promise<THREE.Texture>((resolve, reject) => {
        textureLoader.load(
          apiResult.imageUrl,
          (tex) => {
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.needsUpdate = true;
            resolve(tex);
          },
          undefined,
          (err) => reject(err)
        );
      });
      
      console.log('[PhotogrammetryViewer] 🎯 Applying projective texture from top-down camera...');
      
      // Apply the renovated texture using PROJECTIVE TEXTURE MAPPING
      // This projects the Gemini-generated image from the same top-down camera angle
      // Result: Floor texture looks correct from ALL viewing angles!
      const result = applyRenovatedTextureToMesh(
        meshGroupRef.current,
        renovatedTexture,
        orthoCamera
      );
      
      // Store the restore function so we can remove the projective texture later
      setProjectiveTextureRestore(() => result.restore);
      
      console.log('[PhotogrammetryViewer] ✅ Projective AI floor renovation applied!');
      console.log('[PhotogrammetryViewer] The floor texture is projected from top-down, so it will look correct from any viewing angle.');
      
      // Update state
      setSelectedMaterials(prev => ({
        ...prev,
        flooringId: 'ai-projective',
      }));
      
    } catch (error: any) {
      console.error('[PhotogrammetryViewer] Floor renovation failed:', error);
      alert(`Failed to create AI floor: ${error.message}`);
    } finally {
      setIsGeneratingAITexture(false);
      setGeneratingAISurface(null);
      setPendingFloorMaterial(null);
    }
  }, [pendingFloorMaterial, meshGroupRef]);
  
  const handleModifyMeshTexture = useCallback(async (
    surfaceType: 'flooring' | 'wall' | 'ceiling',
    materialName: string,
    materialDescription: string = ''
  ) => {
    if (!meshGroupRef.current) {
      alert('Please load a 3D scan first');
      return;
    }
    
    setIsGeneratingAITexture(true);
    setGeneratingAISurface(surfaceType);
    
    console.log('[PhotogrammetryViewer] Starting TOP-DOWN AI floor renovation...');
    console.log('[PhotogrammetryViewer] Material:', materialName, '-', materialDescription);
    
    // Store the material info and trigger capture
    setPendingFloorMaterial({ name: materialName, description: materialDescription });
    setTriggerTopDownCapture(true);
    
  }, [meshGroupRef]);
  
  // Handle capture complete
  const handleTopDownCaptureComplete = useCallback(() => {
    setTriggerTopDownCapture(false);
  }, []);
  
  // ============================================================================
  // AI Interior Scan Handlers
  // ============================================================================
  
  const handleStartAIInteriorScan = useCallback(async () => {
    if (!meshGroupRef.current || !sceneRef.current) {
      alert('Please load a 3D scan first');
      return;
    }
    
    console.log('[PhotogrammetryViewer] Starting AI Interior Scan...');
    
    try {
      await aiInteriorScan.startScan(
        meshGroupRef.current,
        sceneRef.current
      );
      
      // Suggestions are updated via the hook's state
      console.log('[PhotogrammetryViewer] AI scan complete');
      console.log('[PhotogrammetryViewer] Suggestions from hook:', aiInteriorScan.suggestions.length);
      if (aiInteriorScan.suggestions.length > 0) {
        console.log('[PhotogrammetryViewer] First suggestion:', aiInteriorScan.suggestions[0]);
      }
      
    } catch (error: any) {
      console.error('[PhotogrammetryViewer] AI scan failed:', error);
      alert(`AI scan failed: ${error.message}`);
    }
  }, [aiInteriorScan, meshGroupRef, sceneRef]);
  
  const handleAISuggestionClick = useCallback((suggestion: RenovationSuggestion) => {
    console.log('[PhotogrammetryViewer] AI suggestion clicked:', suggestion.title);
    aiInteriorScan.selectSuggestion(suggestion);
  }, [aiInteriorScan]);
  
  const handleGenerateAIPreview = useCallback(async (suggestion: RenovationSuggestion) => {
    if (!meshGroupRef.current || !sceneRef.current) {
      return;
    }
    
    console.log('[PhotogrammetryViewer] Generating AI preview for:', suggestion.title);
    
    try {
      await aiInteriorScan.generatePreview(
        suggestion,
        meshGroupRef.current,
        sceneRef.current
      );
      
      console.log('[PhotogrammetryViewer] Preview generated successfully');
      
    } catch (error: any) {
      console.error('[PhotogrammetryViewer] Preview generation failed:', error);
      alert(`Preview generation failed: ${error.message}`);
    }
  }, [aiInteriorScan, meshGroupRef, sceneRef]);
  
  const handleCloseAIPreview = useCallback(() => {
    aiInteriorScan.selectSuggestion(null);
  }, [aiInteriorScan]);
  
  // Segment mesh when it loads for AI texture application
  useEffect(() => {
    if (meshGroupRef.current && calibration && !meshSegmentation) {
      console.log('[PhotogrammetryViewer] Segmenting mesh for AI textures...');
      try {
        const segmentation = segmentMesh(meshGroupRef.current, {
          floorMaxHeight: 0.3,
          counterMinHeight: 0.7,
          counterMaxHeight: 1.2,
          ceilingMinHeight: 2.0,
        });
        setMeshSegmentation(segmentation);
        console.log('[PhotogrammetryViewer] Mesh segmented:', {
          floors: segmentation.floors.length,
          walls: segmentation.walls.length,
          ceilings: segmentation.ceilings.length,
        });
        
        // Check if mesh supports UV renovation
        let supportsUV = false;
        meshGroupRef.current.traverse((child) => {
          if (child instanceof THREE.Mesh && child.geometry) {
            const geo = child.geometry;
            const posAttr = geo.getAttribute('position');
            const uvAttr = geo.getAttribute('uv');
            const idxAttr = geo.getIndex();
            const faces = idxAttr ? idxAttr.count / 3 : (posAttr?.count || 0) / 3;
            
            if (faces > 0 && uvAttr) {
              supportsUV = true;
              console.log('[PhotogrammetryViewer] Mesh supports UV renovation:', faces, 'faces');
            } else {
              console.log('[PhotogrammetryViewer] Mesh does NOT support UV renovation:', faces, 'faces, has UV:', !!uvAttr);
            }
          }
        });
        
        setMeshSupportsUV(supportsUV);
        if (!supportsUV) {
          // Auto-switch to AI Tile method
          setUseUVRenovation(false);
          console.log('[PhotogrammetryViewer] Auto-switching to AI Tile method (mesh lacks faces or UVs)');
        }
        
      } catch (error) {
        console.error('[PhotogrammetryViewer] Mesh segmentation failed:', error);
      }
    }
  }, [meshGroupRef.current, calibration, meshSegmentation]);
  
  // ============================================================================
  // NEW: AI Renovation Preview - Image-to-Image approach
  // Captures the 3D view and sends to Gemini for AI renovation
  // ============================================================================
  const handleAIRenovationPreview = useCallback(async (renovationType: 'flooring' | 'paint', renovationOption: string) => {
    if (!canvasRef.current) {
      alert('Please load a 3D scan first');
      return;
    }
    
    setIsGeneratingAITexture(true);
    setGeneratingAISurface(renovationType === 'flooring' ? 'flooring' : 'wall');
    
    try {
      console.log('[PhotogrammetryViewer] Starting AI Renovation Preview...');
      
      // Find the canvas element inside our container
      const canvas = canvasRef.current.querySelector('canvas');
      if (!canvas) {
        throw new Error('Canvas not found');
      }
      
      // Capture the current view as an image
      const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
      console.log('[PhotogrammetryViewer] Captured canvas screenshot, size:', dataUrl.length);
      
      // Get room dimensions from calibration if available
      let roomDimensions = null;
      if (calibration && meshSegmentation?.floors?.[0]) {
        const floor = meshSegmentation.floors[0];
        const inchesToMeters = 0.0254;
        roomDimensions = {
          width: floor.bounds.size.x * calibration.scaleFactor * inchesToMeters,
          height: floor.bounds.size.z * calibration.scaleFactor * inchesToMeters,
        };
        console.log('[PhotogrammetryViewer] Room dimensions:', roomDimensions);
      }
      
      // Send to AI for renovation
      const response = await fetch('/api/textures/renovate-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomImage: dataUrl,
          renovationType,
          renovationOption,
          roomDimensions,
        }),
      });
      
      const result = await response.json();
      console.log('[PhotogrammetryViewer] AI Renovation result:', result);
      
      if (!result.success) {
        throw new Error(result.error || 'AI renovation failed');
      }
      
      // Show the renovated image in a modal and store the material name for "Apply to 3D"
      setAiRenovationPreview(result.renovatedImageDataUrl);
      setCurrentRenovationMaterial(renovationOption); // Store material for applying to 3D
      setShowRenovationPreviewModal(true);
      
      console.log('[PhotogrammetryViewer] ✅ AI Renovation preview ready!');
      
    } catch (error: any) {
      console.error('[PhotogrammetryViewer] AI Renovation failed:', error);
      alert(`AI Renovation failed: ${error.message || error}`);
    } finally {
      setIsGeneratingAITexture(false);
      setGeneratingAISurface(null);
    }
  }, [canvasRef, calibration, meshSegmentation]);
  
  // ============================================================================
  // NEW: UV-Based Renovation - Edits the texture atlas directly
  // This preserves lighting, shadows, and works from all viewing angles
  // ============================================================================
  const handleUVRenovation = useCallback(async (
    surfaceType: 'floor' | 'wall' | 'ceiling' | 'counter',
    renovationType: string,
    renovationOption: string
  ) => {
    if (!meshGroupRef.current || !meshSegmentation) {
      alert('Please load a 3D scan first and wait for mesh analysis');
      return;
    }
    
    // Find the actual mesh
    let targetMesh: THREE.Mesh | null = null;
    meshGroupRef.current.traverse((child) => {
      if (child instanceof THREE.Mesh && child.geometry && !targetMesh) {
        targetMesh = child;
      }
    });
    
    if (!targetMesh) {
      alert('No mesh found in scene');
      return;
    }
    
    // Check if this is a valid triangle mesh (not a Gaussian splat or point cloud)
    const geometry = targetMesh.geometry;
    const positionAttr = geometry?.getAttribute('position');
    const indexAttr = geometry?.getIndex();
    const faceCount = indexAttr ? indexAttr.count / 3 : (positionAttr?.count || 0) / 3;
    
    if (faceCount === 0) {
      alert(
        '⚠️ UV Renovation requires a triangle mesh.\n\n' +
        'This appears to be a Gaussian splat or point cloud (0 faces detected).\n\n' +
        'Please switch to "🤖 AI Tile" method instead, or use the ' +
        '"AI Renovation Preview" which works with any format.'
      );
      return;
    }
    
    // Check for UV coordinates
    const uvAttr = geometry?.getAttribute('uv');
    if (!uvAttr) {
      alert(
        '⚠️ UV Renovation requires UV coordinates.\n\n' +
        'This mesh has no UV mapping.\n\n' +
        'Please switch to "🤖 AI Tile" method instead.'
      );
      return;
    }
    
    setIsGeneratingAITexture(true);
    setGeneratingAISurface(surfaceType === 'floor' ? 'flooring' : surfaceType === 'wall' ? 'wall' : 'ceiling');
    
    try {
      console.log('[PhotogrammetryViewer] 🎨 Starting UV-based renovation...');
      console.log('[PhotogrammetryViewer] Surface:', surfaceType, '- Material:', renovationOption);
      
      // Store original texture before first modification
      if (!originalMeshTexture) {
        const extraction = extractMeshTexture(targetMesh);
        if (extraction) {
          setOriginalMeshTexture(extraction.originalTexture.clone());
        }
      }
      
      // Perform UV-based renovation
      const request: UVRenovationRequest = {
        mesh: targetMesh,
        segmentation: meshSegmentation,
        targetSurface: surfaceType,
        renovationType,
        renovationOption,
      };
      
      const result = await performUVRenovation(request);
      
      if (result.success) {
        console.log('[PhotogrammetryViewer] ✅ UV renovation applied successfully!');
        console.log('[PhotogrammetryViewer] Coverage:', (result.surfaceMask.coverage * 100).toFixed(1) + '%');
        
        setUVRenovationResult(result);
        
        // Show success message
        alert(`✨ UV renovation applied!\n\nSurface: ${surfaceType}\nMaterial: ${renovationOption}\nCoverage: ${(result.surfaceMask.coverage * 100).toFixed(1)}%`);
      }
      
    } catch (error: any) {
      console.error('[PhotogrammetryViewer] UV renovation failed:', error);
      alert(`UV renovation failed: ${error.message}\n\nTry using the legacy AI texture method instead.`);
    } finally {
      setIsGeneratingAITexture(false);
      setGeneratingAISurface(null);
    }
  }, [meshGroupRef, meshSegmentation, originalMeshTexture]);
  
  // ============================================================================
  // Viewpoint Capture for Pro Renovation
  // User navigates around the 3D model and captures viewpoints
  // ============================================================================
  
  // Start capture mode
  const startViewpointCapture = useCallback(() => {
    setCapturedViewpoints([]);
    setIsCapturingViewpoints(true);
    alert('📸 Viewpoint Capture Mode\n\nNavigate around the 3D model and press "Capture" to save viewpoints.\n\nCapture at least 4-6 views showing the floor/walls from different angles.\n\nPress "Done" when finished.');
  }, []);
  
  // Capture current camera viewpoint
  const captureCurrentViewpoint = useCallback(() => {
    if (!cameraRef.current || !rendererRef.current || !sceneRef.current) {
      console.error('[ViewpointCapture] Missing refs - camera:', !!cameraRef.current, 'renderer:', !!rendererRef.current, 'scene:', !!sceneRef.current);
      alert('Unable to capture viewpoint. Please try again.');
      return;
    }
    
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    
    // Get camera properties
    const position = camera.position.clone();
    
    // Get target - either from controls or calculate from camera direction
    let target: THREE.Vector3;
    if (controls && controls.target) {
      target = controls.target.clone();
    } else {
      // Calculate target from camera direction (looking 10 units forward)
      const direction = new THREE.Vector3(0, 0, -1);
      direction.applyQuaternion(camera.quaternion);
      target = position.clone().add(direction.multiplyScalar(10));
    }
    
    const up = camera.up.clone();
    const fov = camera instanceof THREE.PerspectiveCamera ? camera.fov : 60;
    
    // Render and capture the current view
    rendererRef.current.render(sceneRef.current, camera);
    const imageDataUrl = rendererRef.current.domElement.toDataURL('image/png');
    
    const viewpoint: CapturedViewpoint = {
      id: `viewpoint-${Date.now()}`,
      position: { x: position.x, y: position.y, z: position.z },
      target: { x: target.x, y: target.y, z: target.z },
      up: { x: up.x, y: up.y, z: up.z },
      fov,
      imageDataUrl,
      timestamp: Date.now(),
    };
    
    setCapturedViewpoints(prev => [...prev, viewpoint]);
    
    console.log(`[ViewpointCapture] Captured viewpoint ${capturedViewpoints.length + 1}:`, {
      position: [position.x.toFixed(2), position.y.toFixed(2), position.z.toFixed(2)],
      target: [target.x.toFixed(2), target.y.toFixed(2), target.z.toFixed(2)],
      fov,
    });
    
    // Visual feedback
    const count = capturedViewpoints.length + 1;
    console.log(`[ViewpointCapture] ✅ Viewpoint ${count} captured!`);
  }, [capturedViewpoints.length]);
  
  // Finish capture mode and proceed to renovation
  const finishViewpointCapture = useCallback(() => {
    if (capturedViewpoints.length < 2) {
      alert('Please capture at least 2 viewpoints before proceeding.');
      return;
    }
    setIsCapturingViewpoints(false);
    console.log(`[ViewpointCapture] Finished with ${capturedViewpoints.length} viewpoints`);
  }, [capturedViewpoints.length]);
  
  // Cancel capture mode
  const cancelViewpointCapture = useCallback(() => {
    setCapturedViewpoints([]);
    setIsCapturingViewpoints(false);
  }, []);
  
  // Remove a specific viewpoint
  const removeViewpoint = useCallback((id: string) => {
    setCapturedViewpoints(prev => prev.filter(v => v.id !== id));
  }, []);
  
  // ============================================================================
  // Room Image Capture for Enhanced Tile Method
  // User positions camera for top-down view and captures
  // ============================================================================
  
  const captureRoomImageForTile = useCallback(() => {
    if (!cameraRef.current || !rendererRef.current || !sceneRef.current) {
      console.error('[RoomCapture] Cannot capture - missing refs');
      alert('Unable to capture room view. Please try again.');
      return;
    }
    
    try {
      // Render the scene to capture the current view
      rendererRef.current.render(sceneRef.current, cameraRef.current);
      
      // Get the image data as a JPEG for smaller size
      const imageDataUrl = rendererRef.current.domElement.toDataURL('image/jpeg', 0.9);
      
      // Store camera matrices for later projection
      const camWorldMatrix = cameraRef.current.matrixWorld.clone();
      const camProjMatrix = cameraRef.current.projectionMatrix.clone();
      
      setCapturedRoomImageForTile(imageDataUrl);
      setCapturedRoomCameraMatrix(camWorldMatrix);
      setCapturedRoomProjectionMatrix(camProjMatrix);
      
      console.log('[RoomCapture] ✅ Room image captured for Tile method, size:', imageDataUrl.length);
      console.log('[RoomCapture] Camera position saved for mask projection');
      console.log('[RoomCapture] Position your camera above the floor looking down for best results!');
    } catch (error) {
      console.error('[RoomCapture] Failed to capture room view:', error);
      alert('Failed to capture room view. Please try again.');
    }
  }, []);
  
  const clearRoomImageForTile = useCallback(() => {
    setCapturedRoomImageForTile(null);
    setCapturedRoomCameraMatrix(null);
    setCapturedRoomProjectionMatrix(null);
    console.log('[RoomCapture] Room image cleared');
  }, []);

  // ============================================================================
  // Simple Viewport Capture for Object Generator
  // Returns a base64 data URI of the current viewport view
  // ============================================================================
  const captureViewportForObjectGenerator = useCallback((): string | null => {
    if (!cameraRef.current || !rendererRef.current || !sceneRef.current) {
      console.error('[ObjectGenerator] Cannot capture viewport - missing refs');
      return null;
    }
    
    try {
      // Render the scene to capture the current view
      rendererRef.current.render(sceneRef.current, cameraRef.current);
      
      // Get the image data as a PNG data URI
      const imageDataUrl = rendererRef.current.domElement.toDataURL('image/png');
      
      console.log('[ObjectGenerator] Viewport captured, data length:', imageDataUrl.length);
      return imageDataUrl;
    } catch (error) {
      console.error('[ObjectGenerator] Failed to capture viewport:', error);
      return null;
    }
  }, []);

  // ============================================================================
  // Place Generated Object in Scene
  // ============================================================================
  const placeObjectInScene = useCallback((objectUrl: string, name?: string) => {
    const objectId = `placed-obj-${Date.now()}`;
    const objectName = name || objectUrl.split('/').pop()?.replace('.glb', '') || 'Object';
    
    // Place in front of camera
    let position: [number, number, number] = [0, 0, 0];
    if (cameraRef.current) {
      const camera = cameraRef.current;
      const direction = new THREE.Vector3(0, 0, -1);
      direction.applyQuaternion(camera.quaternion);
      const cameraPos = camera.position.clone();
      const spawnPos = cameraPos.add(direction.multiplyScalar(3)); // 3 units in front
      position = [spawnPos.x, spawnPos.y - 1, spawnPos.z]; // Slightly lower
    }
    
    const newObject: PlacedObjectData = {
      id: objectId,
      url: objectUrl,
      position,
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      name: objectName,
    };
    
    setPlacedObjects(prev => [...prev, newObject]);
    setSelectedObjectId(objectId);
    
    console.log('[PhotogrammetryViewer] Placed object in scene:', newObject);
    
    // Show a success message
    alert(`✅ Object "${objectName}" placed in the scene!\n\nClick on it to select, then use the controls to move/rotate.`);
  }, []);

  // Remove selected object
  const removeSelectedObject = useCallback(() => {
    if (selectedObjectId) {
      setPlacedObjects(prev => prev.filter(obj => obj.id !== selectedObjectId));
      setSelectedObjectId(null);
    }
  }, [selectedObjectId]);

  // Update object position
  const updateObjectPosition = useCallback((objectId: string, position: [number, number, number]) => {
    setPlacedObjects(prev => prev.map(obj => 
      obj.id === objectId ? { ...obj, position } : obj
    ));
  }, []);

  // Update object rotation
  const updateObjectRotation = useCallback((objectId: string, rotation: [number, number, number]) => {
    setPlacedObjects(prev => prev.map(obj => 
      obj.id === objectId ? { ...obj, rotation } : obj
    ));
  }, []);

  // Update object scale
  const updateObjectScale = useCallback((objectId: string, scale: [number, number, number]) => {
    setPlacedObjects(prev => prev.map(obj => 
      obj.id === objectId ? { ...obj, scale } : obj
    ));
  }, []);

  // Nudge selected object position
  const nudgeSelectedObject = useCallback((axis: 'x' | 'y' | 'z', amount: number) => {
    if (!selectedObjectId) return;
    setPlacedObjects(prev => prev.map(obj => {
      if (obj.id !== selectedObjectId) return obj;
      const newPos: [number, number, number] = [...obj.position];
      const axisIndex = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
      newPos[axisIndex] += amount;
      return { ...obj, position: newPos };
    }));
  }, [selectedObjectId]);

  // Rotate selected object
  const rotateSelectedObject = useCallback((axis: 'x' | 'y' | 'z', degrees: number) => {
    if (!selectedObjectId) return;
    const radians = (degrees * Math.PI) / 180;
    setPlacedObjects(prev => prev.map(obj => {
      if (obj.id !== selectedObjectId) return obj;
      const newRot: [number, number, number] = [...obj.rotation];
      const axisIndex = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
      newRot[axisIndex] += radians;
      return { ...obj, rotation: newRot };
    }));
  }, [selectedObjectId]);

  // ============================================================================
  // Keyboard Shortcuts for Object Manipulation
  // ============================================================================
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle when an object is selected
      if (!selectedObjectId) return;
      
      // Don't intercept if user is typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      
      switch (e.key.toLowerCase()) {
        case 'g':
          e.preventDefault();
          setTransformMode('translate');
          break;
        case 'r':
          e.preventDefault();
          setTransformMode('rotate');
          break;
        case 's':
          // Only if not ctrl+s (save)
          if (!e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            setTransformMode('scale');
          }
          break;
        case 'escape':
          e.preventDefault();
          setSelectedObjectId(null);
          break;
        case 'delete':
        case 'backspace':
          e.preventDefault();
          removeSelectedObject();
          break;
        // Arrow keys for nudging
        case 'arrowleft':
          e.preventDefault();
          nudgeSelectedObject('x', e.shiftKey ? -0.5 : -0.1);
          break;
        case 'arrowright':
          e.preventDefault();
          nudgeSelectedObject('x', e.shiftKey ? 0.5 : 0.1);
          break;
        case 'arrowup':
          e.preventDefault();
          if (e.altKey) {
            nudgeSelectedObject('y', e.shiftKey ? 0.5 : 0.1);
          } else {
            nudgeSelectedObject('z', e.shiftKey ? -0.5 : -0.1);
          }
          break;
        case 'arrowdown':
          e.preventDefault();
          if (e.altKey) {
            nudgeSelectedObject('y', e.shiftKey ? -0.5 : -0.1);
          } else {
            nudgeSelectedObject('z', e.shiftKey ? 0.5 : 0.1);
          }
          break;
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedObjectId, removeSelectedObject, nudgeSelectedObject]);

  // ============================================================================
  // PRO: Multi-view Gemini + OpenMVS Retexturing (Best Quality)
  // ============================================================================
  const handleProRenovation = useCallback(async (
    surfaceType: 'floor' | 'wall' | 'ceiling',
    materialName: string
  ) => {
    if (!meshGroupRef.current) {
      alert('Please load a 3D scan first');
      return;
    }
    
    // Find the LARGEST mesh in the scene (the main room, not small fragments)
    let targetMesh: THREE.Mesh | null = null;
    let largestVertexCount = 0;
    
    meshGroupRef.current.traverse((child) => {
      if (child instanceof THREE.Mesh && child.geometry) {
        const vertexCount = child.geometry.attributes.position?.count || 0;
        if (vertexCount > largestVertexCount) {
          largestVertexCount = vertexCount;
          targetMesh = child;
        }
      }
    });
    
    console.log(`[PhotogrammetryViewer] Found largest mesh with ${largestVertexCount} vertices`);
    
    if (!targetMesh) {
      alert('No mesh found in scene');
      return;
    }
    
    setIsRetexturing(true);
    setRetexturingProgress({ stage: 'Initializing...', progress: 0 });
    
    try {
      console.log('[PhotogrammetryViewer] 🚀 Starting Pro renovation retexturing...');
      console.log('[PhotogrammetryViewer] Surface:', surfaceType, '- Material:', materialName);
      
      // Determine renovation type and option from surface and material
      const renovationType = surfaceType === 'floor' ? 'flooring' : 'paint';
      const renovationOption = materialName.toLowerCase().includes('walnut') ? 'walnut' :
                               materialName.toLowerCase().includes('oak') ? 'hardwood' :
                               materialName.toLowerCase().includes('vinyl') ? 'vinyl' :
                               materialName.toLowerCase().includes('tile') ? 'tile' :
                               materialName.toLowerCase().includes('marble') ? 'marble' :
                               materialName.toLowerCase().includes('white') ? 'white' :
                               materialName.toLowerCase().includes('gray') ? 'gray' :
                               'hardwood';
      
      // Build custom prompt
      const customPrompt = surfaceType === 'floor'
        ? `Replace the floor with beautiful ${materialName}. Keep all walls, furniture, and objects exactly the same.`
        : surfaceType === 'wall'
        ? `Repaint the walls with ${materialName}. Keep the floor, ceiling, furniture, and objects exactly the same.`
        : `Repaint the ceiling with ${materialName}. Keep the floor, walls, furniture, and objects exactly the same.`;
      
      // Create a temporary scene for rendering
      const tempScene = new THREE.Scene();
      tempScene.background = new THREE.Color(0x808080);
      
      // Deep clone the mesh with its material and texture
      const clonedMesh = targetMesh.clone();
      // Deep clone the material to preserve texture AND set to DoubleSide for interior views
      if (targetMesh.material) {
        if (Array.isArray(targetMesh.material)) {
          clonedMesh.material = targetMesh.material.map(m => {
            const cloned = m.clone();
            cloned.side = THREE.DoubleSide;
            return cloned;
          });
        } else {
          clonedMesh.material = targetMesh.material.clone();
          clonedMesh.material.side = THREE.DoubleSide;
          // Copy texture reference
          const srcMat = targetMesh.material as THREE.MeshStandardMaterial;
          const dstMat = clonedMesh.material as THREE.MeshStandardMaterial;
          if (srcMat.map) {
            dstMat.map = srcMat.map;
            dstMat.needsUpdate = true;
          }
        }
      }
      
      // CENTER THE MESH AT ORIGIN for consistent rendering
      // First, compute the world bounding box of the original mesh
      targetMesh.updateMatrixWorld(true);
      const worldBox = new THREE.Box3().setFromObject(targetMesh);
      const worldCenter = new THREE.Vector3();
      worldBox.getCenter(worldCenter);
      
      console.log('[PhotogrammetryViewer] Original mesh world center:', worldCenter);
      
      // Reset cloned mesh transform and center it at origin
      clonedMesh.position.set(0, 0, 0);
      clonedMesh.rotation.set(0, 0, 0);
      clonedMesh.scale.set(1, 1, 1);
      
      // Move geometry so mesh is centered at origin
      clonedMesh.geometry = clonedMesh.geometry.clone();
      clonedMesh.geometry.computeBoundingBox();
      const localCenter = new THREE.Vector3();
      clonedMesh.geometry.boundingBox!.getCenter(localCenter);
      clonedMesh.geometry.translate(-localCenter.x, -localCenter.y, -localCenter.z);
      clonedMesh.geometry.computeBoundingBox();
      
      // Now also translate so floor is at Y=0
      const newBbox = clonedMesh.geometry.boundingBox!;
      const floorOffset = -newBbox.min.y;
      clonedMesh.geometry.translate(0, floorOffset, 0);
      clonedMesh.geometry.computeBoundingBox();
      
      console.log('[PhotogrammetryViewer] Centered mesh bounding box:', clonedMesh.geometry.boundingBox);
      
      tempScene.add(clonedMesh);
      
      // Add some lighting
      const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
      const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
      directionalLight.position.set(5, 10, 5);
      tempScene.add(ambientLight);
      tempScene.add(directionalLight);
      
      // Build the retexturing request
      // Convert captured viewpoints to RenovationViewpoint format if available
      let viewpoints: RenovationViewpoint[] = [];
      
      if (capturedViewpoints.length > 0) {
        console.log('[PhotogrammetryViewer] 📸 Using', capturedViewpoints.length, 'manually captured viewpoints');
        
        // CRITICAL: Transform captured viewpoints to match the centered mesh
        // The mesh was centered at origin and floor moved to Y=0
        // We need to apply the same transform to camera positions and targets
        // Transform = translate by (-localCenter.x, -localCenter.y + floorOffset, -localCenter.z)
        const transformOffset = new THREE.Vector3(
          -localCenter.x,
          -localCenter.y + floorOffset,
          -localCenter.z
        );
        
        console.log('[PhotogrammetryViewer] Camera transform offset:', transformOffset.toArray());
        
        viewpoints = capturedViewpoints.map((vp, idx) => {
          // Apply the same centering transform to camera position and target
          const transformedPos = new THREE.Vector3(vp.position.x, vp.position.y, vp.position.z).add(transformOffset);
          const transformedTarget = new THREE.Vector3(vp.target.x, vp.target.y, vp.target.z).add(transformOffset);
          
          return {
            position: transformedPos,
            target: transformedTarget,
            up: new THREE.Vector3(vp.up.x, vp.up.y, vp.up.z),
            fov: vp.fov,
            name: `manual-view-${idx + 1}`,
          };
        });
        
        console.log('[PhotogrammetryViewer] Transformed viewpoint 0 pos:', viewpoints[0].position.toArray());
      } else {
        console.log('[PhotogrammetryViewer] 🔄 No captured viewpoints, will auto-generate');
      }
      
      const request = {
        mesh: clonedMesh,
        scene: tempScene,
        viewpoints, // Use captured viewpoints if available, otherwise empty for auto-generation
        capturedImages: capturedViewpoints.length > 0 
          ? capturedViewpoints.map(vp => vp.imageDataUrl) 
          : undefined, // Pass pre-captured images to skip re-rendering
        renovationType,
        renovationOption,
        customPrompt,
      };
      
      // Perform the multi-view retexturing
      const result = await performRenovationRetexturing(
        request,
        (stage: string, progress: number) => {
          setRetexturingProgress({ stage, progress });
        }
      );
      
      if (result.success && result.newTextureUrl) {
        console.log('[PhotogrammetryViewer] ✅ Pro renovation complete!');
        
        // Replace the mesh with the retextured one
        if (result.retexturedMesh && meshGroupRef.current) {
          console.log('[PhotogrammetryViewer] Replacing mesh with retextured version...');
          
          // Find all meshes in the group and get the largest one's transform
          let oldMesh: THREE.Mesh | null = null;
          let largestVertexCount = 0;
          
          meshGroupRef.current.traverse((child) => {
            if (child instanceof THREE.Mesh && child.geometry) {
              const vertexCount = child.geometry.attributes.position?.count || 0;
              if (vertexCount > largestVertexCount) {
                largestVertexCount = vertexCount;
                oldMesh = child;
              }
            }
          });
          
          const retexturedMesh = result.retexturedMesh;
          
          // Copy transform from the old mesh if found
          if (oldMesh) {
            console.log('[PhotogrammetryViewer] Old mesh position:', JSON.stringify(oldMesh.position.toArray()));
            console.log('[PhotogrammetryViewer] Old mesh scale:', JSON.stringify(oldMesh.scale.toArray()));
            console.log('[PhotogrammetryViewer] Old mesh rotation:', JSON.stringify([oldMesh.rotation.x, oldMesh.rotation.y, oldMesh.rotation.z]));
            console.log('[PhotogrammetryViewer] Old mesh parent:', oldMesh.parent?.name || oldMesh.parent?.type);
            console.log('[PhotogrammetryViewer] Old mesh visible:', oldMesh.visible);
            
            // IMPORTANT: The retextured mesh from OBJ should have the same geometry coordinates
            // as what we sent (which was centered). So we need to apply the same transform.
            retexturedMesh.position.copy(oldMesh.position);
            retexturedMesh.rotation.copy(oldMesh.rotation);
            retexturedMesh.scale.copy(oldMesh.scale);
            retexturedMesh.visible = true; // Ensure it's visible
            retexturedMesh.frustumCulled = false; // Disable frustum culling for debugging
            retexturedMesh.updateMatrix();
            retexturedMesh.updateMatrixWorld(true);
            
            // Get the parent before removing
            const parentGroup = oldMesh.parent;
            
            // Instead of removing, make old mesh invisible for debugging
            oldMesh.visible = false;
            
            // Add the new mesh to the SAME parent
            if (parentGroup) {
              parentGroup.add(retexturedMesh);
              console.log('[PhotogrammetryViewer] Added retextured mesh to parent:', parentGroup.name || parentGroup.type);
              console.log('[PhotogrammetryViewer] Parent now has', parentGroup.children.length, 'children');
            } else {
              // Fallback: add to meshGroupRef
              meshGroupRef.current.add(retexturedMesh);
              console.log('[PhotogrammetryViewer] Added retextured mesh to meshGroupRef (no parent found)');
            }
            
            // Check if material needs updating
            const mat = (retexturedMesh as any).material;
            if (mat) {
              mat.needsUpdate = true;
              if (mat.map) {
                mat.map.needsUpdate = true;
              }
            }
            
          } else {
            // No old mesh found, just add the new one
            retexturedMesh.frustumCulled = false;
            meshGroupRef.current.add(retexturedMesh);
            console.log('[PhotogrammetryViewer] No old mesh found, added retextured mesh to meshGroupRef');
          }
          
          // Force update of bounding box
          retexturedMesh.geometry.computeBoundingBox();
          retexturedMesh.geometry.computeBoundingSphere();
          
          console.log('[PhotogrammetryViewer] New mesh position:', JSON.stringify(retexturedMesh.position.toArray()));
          console.log('[PhotogrammetryViewer] New mesh scale:', JSON.stringify(retexturedMesh.scale.toArray()));
          console.log('[PhotogrammetryViewer] New mesh rotation:', JSON.stringify(retexturedMesh.rotation.toArray()));
          console.log('[PhotogrammetryViewer] New mesh visible:', retexturedMesh.visible);
          console.log('[PhotogrammetryViewer] New mesh parent:', retexturedMesh.parent?.name || retexturedMesh.parent?.type);
          
          // Check camera distance to mesh
          if (cameraRef.current && retexturedMesh.geometry.boundingSphere) {
            const dist = cameraRef.current.position.distanceTo(retexturedMesh.position);
            console.log('[PhotogrammetryViewer] Camera distance to new mesh:', dist);
            console.log('[PhotogrammetryViewer] Mesh bounding sphere radius:', retexturedMesh.geometry.boundingSphere.radius);
          }
          
          // 🔍 DEBUG: Add a bright marker sphere at the mesh center to confirm rendering works
          const debugMarkerGeo = new THREE.SphereGeometry(0.2, 16, 16);
          const debugMarkerMat = new THREE.MeshBasicMaterial({ color: 0xff00ff, wireframe: true }); // Bright magenta
          const debugMarker = new THREE.Mesh(debugMarkerGeo, debugMarkerMat);
          debugMarker.position.copy(retexturedMesh.position);
          debugMarker.name = 'DEBUG_RETEXTURE_MARKER';
          if (retexturedMesh.parent) {
            retexturedMesh.parent.add(debugMarker);
            console.log('[PhotogrammetryViewer] 🔍 DEBUG: Added magenta sphere marker at mesh position');
          }
          
          // 🔍 DEBUG: Log full scene hierarchy
          console.log('[PhotogrammetryViewer] 🔍 DEBUG: Scene hierarchy dump:');
          sceneRef.current?.traverse((obj: THREE.Object3D) => {
            const objAny = obj as any;
            const meshInfo = objAny.isMesh ? ` [MESH: ${objAny.geometry?.attributes?.position?.count || 0} verts]` : '';
            console.log(`  ${'  '.repeat(getDepth(obj))}${obj.type}: ${obj.name || '(unnamed)'} visible=${obj.visible}${meshInfo}`);
          });
          
          // Helper function to get object depth
          function getDepth(obj: THREE.Object3D): number {
            let depth = 0;
            let current = obj.parent;
            while (current) { depth++; current = current.parent; }
            return depth;
          }
          
          console.log('[PhotogrammetryViewer] ✅ Mesh replaced with retextured version');

        }
        
        // Show success message
        const previewCount = result.editedViews?.length || 0;
        alert(`🚀 Pro renovation complete!\n\nSurface: ${surfaceType}\nMaterial: ${materialName}\nViews processed: ${previewCount}\nProcessing time: ${((result.processingTimeMs || 0) / 1000).toFixed(1)}s\n\n✅ The 3D model has been updated with the new texture!`);
        
        // Offer to download the textured mesh
        if (result.newTextureUrl) {
          const downloadLink = document.createElement('a');
          downloadLink.href = result.newTextureUrl;
          downloadLink.download = `renovated-${surfaceType}-${Date.now()}.png`;
          // Don't auto-download, user can access from result
        }
      } else {
        throw new Error(result.error || 'Retexturing failed');
      }
      
    } catch (error: any) {
      console.error('[PhotogrammetryViewer] Pro renovation failed:', error);
      alert(`Pro renovation failed: ${error.message}\n\nTry using UV or Tile method instead.`);
    } finally {
      setIsRetexturing(false);
      setRetexturingProgress(null);
    }
  }, [meshGroupRef, capturedViewpoints]);
  
  // ============================================================================
  // TRIPLANAR: Real-time triplanar projection renovation (RECOMMENDED)
  // ============================================================================
  const handleTriplanarRenovation = useCallback(async (
    surfaceType: 'floor' | 'wall' | 'ceiling',
    materialName: string
  ) => {
    if (!meshGroupRef.current || !calibration) {
      alert('Please load and calibrate a 3D scan first');
      return;
    }
    
    // Find the LARGEST mesh in the scene (the main room, not small fragments)
    let targetMesh: THREE.Mesh | null = null;
    let largestVertexCount = 0;
    
    meshGroupRef.current.traverse((child) => {
      if (child instanceof THREE.Mesh && child.geometry) {
        const vertexCount = child.geometry.attributes.position?.count || 0;
        if (vertexCount > largestVertexCount) {
          largestVertexCount = vertexCount;
          targetMesh = child;
        }
      }
    });
    
    if (!targetMesh) {
      alert('No mesh found in scene');
      return;
    }
    
    setIsRetexturing(true);
    setRetexturingProgress({ stage: 'Starting triplanar renovation...', progress: 0 });
    
    try {
      console.log('[PhotogrammetryViewer] ⚡ Starting Triplanar renovation...');
      console.log('[PhotogrammetryViewer] Surface:', surfaceType, '- Material:', materialName);
      
      // Import the triplanar service dynamically to avoid circular deps
      const { applySegmentRenovation, segmentMesh } = await import('../services/triplanarRenovationService').then(async m => {
        const segModule = await import('../services/meshSegmentationService');
        return { applySegmentRenovation: m.applySegmentRenovation, segmentMesh: segModule.segmentMesh };
      });
      
      // Segment the mesh to find the target surface
      setRetexturingProgress({ stage: 'Analyzing surfaces...', progress: 0.1 });
      const segmentation = segmentMesh(meshGroupRef.current);
      
      // Get the appropriate segment
      let segment;
      if (surfaceType === 'floor' && segmentation.floors.length > 0) {
        segment = segmentation.floors[0];
      } else if (surfaceType === 'wall' && segmentation.walls.length > 0) {
        segment = segmentation.walls[0];
      } else if (surfaceType === 'ceiling' && segmentation.ceilings.length > 0) {
        segment = segmentation.ceilings[0];
      }
      
      if (!segment) {
        throw new Error(`No ${surfaceType} segment found in mesh`);
      }
      
      // Determine renovation type from material name
      const renovationType = surfaceType === 'floor' ? 'flooring' : 'paint';
      const renovationOption = materialName.toLowerCase().includes('walnut') ? 'walnut' :
                               materialName.toLowerCase().includes('oak') ? 'hardwood' :
                               materialName.toLowerCase().includes('vinyl') ? 'vinyl' :
                               materialName.toLowerCase().includes('tile') ? 'tile' :
                               materialName.toLowerCase().includes('marble') ? 'marble' :
                               materialName.toLowerCase().includes('white') ? 'white' :
                               materialName.toLowerCase().includes('gray') ? 'gray' :
                               'hardwood';
      
      // Get world scale from calibration
      const worldScale = calibration?.scaleFactor || 1.0;
      
      // Apply triplanar renovation
      const result = await applySegmentRenovation(
        targetMesh,
        segment,
        renovationType,
        renovationOption,
        worldScale,
        (stage, progress) => {
          setRetexturingProgress({ stage, progress });
        }
      );
      
      if (result.success) {
        console.log('[PhotogrammetryViewer] ✅ Triplanar renovation applied!');
        setRetexturingProgress({ stage: 'Complete!', progress: 1 });
        
        // Store restore function for later
        // Could save to state if needed: setTriplanarRestoreFn(() => result.restore);
        
        alert(`⚡ Triplanar renovation complete!\n\nSurface: ${surfaceType}\nMaterial: ${materialName}\n\n✅ View the model from any angle - the texture is correct from all viewpoints!`);
      } else {
        throw new Error(result.error || 'Triplanar renovation failed');
      }
      
    } catch (error: any) {
      console.error('[PhotogrammetryViewer] Triplanar renovation failed:', error);
      alert(`Triplanar renovation failed: ${error.message}`);
    } finally {
      setIsRetexturing(false);
      setTimeout(() => setRetexturingProgress(null), 2000);
    }
  }, [meshGroupRef, calibration]);
  
  // ============================================================================
  // ENHANCED TILE: Contextual floor generation with plank sizing
  // ============================================================================
  const handleEnhancedTileRenovation = useCallback(async (
    surfaceType: 'floor' | 'wall' | 'ceiling',
    materialName: string,
    materialOption: string,
    roomImageBase64?: string
  ) => {
    if (!meshGroupRef.current || !calibration) {
      alert('Please load and calibrate a 3D scan first');
      return;
    }
    
    // Check if we have a room image for better results
    const hasRoomImage = roomImageBase64 && roomImageBase64.length > 100;
    if (!hasRoomImage) {
      console.warn('[PhotogrammetryViewer] No room image provided - will generate standalone tile texture');
    } else {
      console.log('[PhotogrammetryViewer] Using captured room image for contextual floor generation');
    }
    
    // Find the LARGEST mesh in the scene (the main room)
    let targetMesh: THREE.Mesh | null = null;
    let largestVertexCount = 0;
    
    meshGroupRef.current.traverse((child) => {
      if (child instanceof THREE.Mesh && child.geometry) {
        const vertexCount = child.geometry.attributes.position?.count || 0;
        if (vertexCount > largestVertexCount) {
          largestVertexCount = vertexCount;
          targetMesh = child;
        }
      }
    });
    
    if (!targetMesh) {
      alert('No mesh found in scene');
      return;
    }
    
    setIsRetexturing(true);
    setRetexturingProgress({ stage: hasRoomImage ? 'Processing room image...' : 'Generating floor texture...', progress: 0 });
    
    try {
      console.log('[PhotogrammetryViewer] 🔄 Starting Enhanced Tile renovation...');
      console.log('[PhotogrammetryViewer] Surface:', surfaceType, '- Material:', materialName, '- Option:', materialOption);
      
      // Import the enhanced tile service
      const { 
        performEnhancedTileRenovation, 
        getFloorboardSpecs,
      } = await import('../services/enhancedTileRenovationService');
      
      const { segmentMesh } = await import('../services/meshSegmentationService');
      
      // Segment the mesh to find the floor
      setRetexturingProgress({ stage: 'Analyzing surfaces...', progress: 0.1 });
      const segmentation = segmentMesh(meshGroupRef.current);
      
      // Get the floor segment
      const segment = segmentation.floors[0];
      if (!segment) {
        throw new Error('No floor segment found in mesh');
      }
      
      // Get room dimensions from calibration
      const roomWidth = calibration.roomDimensions?.width || 10;
      const roomLength = calibration.roomDimensions?.length || 12;
      const unit = calibration.roomDimensions?.unit || 'ft';
      
      // Convert to meters
      const widthMeters = unit === 'ft' ? roomWidth * 0.3048 : roomWidth / 100;
      const lengthMeters = unit === 'ft' ? roomLength * 0.3048 : roomLength / 100;
      
      // Get floorboard specs
      const floorboardSpecs = getFloorboardSpecs(materialOption);
      
      console.log('[PhotogrammetryViewer] Room:', widthMeters.toFixed(2), 'x', lengthMeters.toFixed(2), 'm');
      console.log('[PhotogrammetryViewer] Floorboard specs:', floorboardSpecs);
      
      // We need the Three.js context - get from the canvas
      const canvas = document.querySelector('canvas');
      if (!canvas) {
        throw new Error('Canvas not found');
      }
      
      // Create a temporary renderer for the top-down capture
      // Note: In production, this should use the actual renderer from R3F
      // For now, we'll use the API directly without the top-down capture
      
      setRetexturingProgress({ stage: 'Generating floor with AI...', progress: 0.3 });
      
      // Call the contextual floor generation API with the captured room image
      const response = await fetch('/api/renovation-preview/generate-contextual-floor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomImageBase64: roomImageBase64 || null, // Use captured room image if available
          materialType: 'flooring',
          materialOption,
          roomDimensions: { widthMeters, lengthMeters },
          plankSpecs: floorboardSpecs,
          extractPattern: true,
        }),
      });
      
      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }
      
      const result = await response.json();
      
      if (!result.success || !result.tileTextureUrl) {
        // Fallback to triplanar if API fails
        console.warn('[PhotogrammetryViewer] Enhanced tile API failed, falling back to triplanar');
        setIsRetexturing(false);
        setRetexturingProgress(null);
        return handleTriplanarRenovation(surfaceType, materialName);
      }
      
      console.log('[PhotogrammetryViewer] ✅ Got texture from contextual floor generation');
      console.log('[PhotogrammetryViewer] Texture URL length:', result.tileTextureUrl.length);
      
      // ========================================================================
      // USE SEGMENTED FLOOR FACES (Blue mesh system)
      // The mesh segmentation already identified which faces are floor!
      // ========================================================================
      
      setRetexturingProgress({ stage: 'Applying texture to segmented floor...', progress: 0.6 });
      
      const faceIndices = new Set(segment.faceIndices);
      console.log('[PhotogrammetryViewer] Floor segment has', faceIndices.size, 'faces');
      
      // Import face-based renovation service
      const { applyFloorTextureToSegmentedFaces } = await import('../services/faceBasedRenovationService');
      
      const faceResult = await applyFloorTextureToSegmentedFaces(
        targetMesh,
        result.tileTextureUrl,
        faceIndices,
        (stage, progress) => {
          setRetexturingProgress({ stage, progress: 0.6 + progress * 0.4 });
        }
      );
      
      if (faceResult.success) {
        console.log('[PhotogrammetryViewer] ✅ Floor renovation complete!');
        console.log('[PhotogrammetryViewer] Floor faces:', faceResult.floorFaceCount, '/', faceResult.totalFaceCount);
        setRetexturingProgress({ stage: 'Complete!', progress: 1 });
        
        alert(`🔄 Floor renovation complete!\n\nSurface: ${surfaceType}\nMaterial: ${materialName}\n\n✅ Applied to ${faceResult.floorFaceCount} floor faces\n(${Math.round(faceResult.floorFaceCount / faceResult.totalFaceCount * 100)}% of mesh)`);
        
        setIsRetexturing(false);
        setRetexturingProgress(null);
        return;
      } else {
        console.warn('[PhotogrammetryViewer] Face-based approach failed:', faceResult.error);
        // Fall through to triplanar fallback
      }
      
      // ========================================================================
      // FALLBACK: Use Triplanar if segmented faces approach fails
      // ========================================================================
      
      setRetexturingProgress({ stage: 'Applying texture (fallback)...', progress: 0.7 });
      
      const { applySegmentRenovation } = await import('../services/triplanarRenovationService');
      
      const applyResult = await applySegmentRenovation(
        targetMesh,
        segment,
        'flooring',
        materialOption,
        calibration.scaleFactor || 1.0,
        (stage, progress) => {
          setRetexturingProgress({ stage, progress: 0.7 + progress * 0.3 });
        },
        result.tileTextureUrl
      );
      
      if (applyResult.success) {
        console.log('[PhotogrammetryViewer] ✅ Enhanced tile renovation applied!');
        setRetexturingProgress({ stage: 'Complete!', progress: 1 });
        
        alert(`🔄 Enhanced Tile renovation complete!\n\nSurface: ${surfaceType}\nMaterial: ${materialName}\nPlank width: ${floorboardSpecs.plankWidthInches}" × ${floorboardSpecs.plankLengthInches}"\n\n✅ Floor texture uses proper plank sizing for this room!`);
      } else {
        throw new Error(applyResult.error || 'Failed to apply texture');
      }
      
    } catch (error: any) {
      console.error('[PhotogrammetryViewer] Enhanced tile renovation failed:', error);
      
      // Fallback to triplanar
      console.log('[PhotogrammetryViewer] Falling back to triplanar renovation...');
      setIsRetexturing(false);
      setRetexturingProgress(null);
      return handleTriplanarRenovation(surfaceType, materialName);
    } finally {
      setIsRetexturing(false);
      setTimeout(() => setRetexturingProgress(null), 2000);
    }
  }, [meshGroupRef, calibration, handleTriplanarRenovation, capturedRoomCameraMatrix, capturedRoomProjectionMatrix, cameraRef, aiFloorOutline, aiFloorFill]);
  
  // Reset UV renovation to original
  const resetUVRenovation = useCallback(() => {
    if (!originalMeshTexture || !meshGroupRef.current) return;
    
    meshGroupRef.current.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        for (const mat of materials) {
          if (mat instanceof THREE.MeshStandardMaterial || 
              mat instanceof THREE.MeshBasicMaterial ||
              mat instanceof THREE.MeshPhongMaterial) {
            mat.map = originalMeshTexture;
            mat.needsUpdate = true;
          }
        }
      }
    });
    
    setUVRenovationResult(null);
    console.log('[PhotogrammetryViewer] Restored original texture');
  }, [originalMeshTexture, meshGroupRef]);
  
  // ============================================================================
  // Apply AI Floor Texture to 3D Model
  // Generates a tileable floor texture and applies it to floor surfaces
  // ============================================================================
  const handleApplyFloorTo3D = useCallback(async () => {
    if (!meshGroupRef.current || !currentRenovationMaterial) {
      alert('No mesh or material available');
      return;
    }
    
    setIsApplyingTo3D(true);
    
    try {
      console.log('[PhotogrammetryViewer] Generating floor texture for 3D:', currentRenovationMaterial);
      
      // Determine flooring type for the prompt
      const isWalnut = currentRenovationMaterial.toLowerCase().includes('walnut');
      const isOak = currentRenovationMaterial.toLowerCase().includes('oak');
      const isVinyl = currentRenovationMaterial.toLowerCase().includes('vinyl');
      const isGray = currentRenovationMaterial.toLowerCase().includes('gray');
      
      let renovationOption = 'hardwood';
      if (isWalnut) renovationOption = 'walnut';
      if (isVinyl) renovationOption = 'vinyl';
      if (isGray) renovationOption = 'vinyl'; // Gray is usually vinyl
      
      // Generate a tileable floor texture using AI
      const response = await fetch('/api/textures/generate-texture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          segmentType: 'floor',
          renovationType: 'flooring',
          renovationOption,
          prompt: `Generate a seamless tileable texture of ${currentRenovationMaterial} flooring. 
Top-down view, photorealistic. 
${isWalnut ? 'Rich dark walnut brown wood planks with visible grain.' : ''}
${isOak ? 'Warm honey oak wood planks with natural grain pattern.' : ''}
${isVinyl ? 'Modern vinyl plank flooring with subtle wood-look texture.' : ''}
${isGray ? 'Cool gray toned flooring planks.' : ''}
Planks running horizontally, about 5-7 inches wide.
Thin dark gaps between boards.
No shadows, no reflections, no objects.
Perfect for tiling/repeating as a 3D texture.`,
          useProModel: false,
        }),
      });
      
      const result = await response.json();
      
      if (!result.success) {
        throw new Error(result.error || 'Failed to generate floor texture');
      }
      
      console.log('[PhotogrammetryViewer] Generated floor texture, applying to mesh...');
      
      // Load the texture
      const textureUrl = result.textureDataUrl || result.textureUrl;
      console.log('[PhotogrammetryViewer] Loading texture from URL:', textureUrl?.substring(0, 50) + '...');
      
      const textureLoader = new THREE.TextureLoader();
      
      let floorTexture: THREE.Texture;
      try {
        floorTexture = await new Promise<THREE.Texture>((resolve, reject) => {
          textureLoader.load(
            textureUrl,
            (tex) => {
              console.log('[PhotogrammetryViewer] Texture loaded successfully, size:', tex.image?.width, 'x', tex.image?.height);
              resolve(tex);
            },
            (progress) => console.log('[PhotogrammetryViewer] Texture loading...'),
            (err) => {
              console.error('[PhotogrammetryViewer] Texture load error:', err);
              reject(err);
            }
          );
        });
      } catch (loadError) {
        console.error('[PhotogrammetryViewer] Failed to load texture, using fallback color');
        // Create a simple colored texture as fallback
        const canvas = document.createElement('canvas');
        canvas.width = 512;
        canvas.height = 512;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#8B4513'; // Saddle brown for wood
        ctx.fillRect(0, 0, 512, 512);
        floorTexture = new THREE.CanvasTexture(canvas);
      }
      
      // Configure texture for tiling
      floorTexture.wrapS = THREE.RepeatWrapping;
      floorTexture.wrapT = THREE.RepeatWrapping;
      floorTexture.colorSpace = THREE.SRGBColorSpace;
      
      // Calculate repeat based on room size (if calibrated)
      const textureMetersPerRepeat = 1.0; // 1 meter per texture repeat
      if (calibration && meshSegmentation?.floors?.[0]) {
        const floor = meshSegmentation.floors[0];
        const inchesToMeters = 0.0254;
        const roomWidth = floor.bounds.size.x * calibration.scaleFactor * inchesToMeters;
        const roomDepth = floor.bounds.size.z * calibration.scaleFactor * inchesToMeters;
        floorTexture.repeat.set(roomWidth / textureMetersPerRepeat, roomDepth / textureMetersPerRepeat);
        console.log('[PhotogrammetryViewer] Texture repeat:', floorTexture.repeat.x, 'x', floorTexture.repeat.y);
      } else {
        floorTexture.repeat.set(4, 4); // Default repeat
      }
      
      floorTexture.needsUpdate = true;
      
      // Create floor material - use MeshBasicMaterial to ensure it's always visible
      // regardless of lighting conditions
      const floorMaterial = new THREE.MeshBasicMaterial({
        map: floorTexture,
        side: THREE.DoubleSide,
        transparent: false,
      });
      
      // Apply to floor triangles or create overlay
      if (meshSegmentation?.floors?.[0]) {
        const floorSegment = meshSegmentation.floors[0];
        const bounds = floorSegment.bounds;
        
        // Get the size of the plane in MESH COORDINATES (not meters)
        // The plane needs to match the mesh coordinate system
        const planeWidth = bounds.size.x * 1.1;  // 10% larger to cover floor edges
        const planeDepth = bounds.size.z * 1.1;
        
        // Position the floor plane at the TOP of the floor bounds (surface level)
        // Add a small offset to ensure it renders above the mesh
        const floorY = bounds.max.y + 0.1;  // Just above the floor surface
        
        console.log('[PhotogrammetryViewer] Creating floor plane:', {
          meshCoords: { width: planeWidth, depth: planeDepth },
          center: bounds.center,
          floorY,
          boundsY: { min: bounds.min.y, max: bounds.max.y }
        });
        
        const floorGeometry = new THREE.PlaneGeometry(planeWidth, planeDepth);
        
        const floorMesh = new THREE.Mesh(floorGeometry, floorMaterial);
        floorMesh.rotation.x = -Math.PI / 2; // Make horizontal
        
        // Position at floor surface level (max Y of floor bounds)
        floorMesh.position.set(
          bounds.center.x, 
          floorY,
          bounds.center.z
        );
        floorMesh.name = 'ai-floor-overlay';
        floorMesh.renderOrder = 999; // Render on top of everything
        
        // Enable polygon offset and depth settings to ensure visibility
        floorMaterial.polygonOffset = true;
        floorMaterial.polygonOffsetFactor = -4;
        floorMaterial.polygonOffsetUnits = -4;
        floorMaterial.depthWrite = true;
        floorMaterial.depthTest = true;
        
        // Remove old overlay if exists
        if (aiFloorOverlay) {
          aiFloorOverlay.geometry.dispose();
          if (aiFloorOverlay.material instanceof THREE.Material) {
            aiFloorOverlay.material.dispose();
          }
        }
        
        // Set the floor overlay (React will handle adding it to the scene)
        setAiFloorOverlay(floorMesh);
        
        console.log('[PhotogrammetryViewer] ✅ Floor texture applied to 3D model!', {
          position: floorMesh.position,
          size: { width: planeWidth, depth: planeDepth }
        });
      } else {
        console.warn('[PhotogrammetryViewer] No floor segmentation available');
        alert('No floor detected in mesh segmentation. Please calibrate the room first.');
      }
      
      // Close the modal
      setShowRenovationPreviewModal(false);
      setAiRenovationPreview(null);
      
    } catch (error: any) {
      console.error('[PhotogrammetryViewer] Failed to apply floor to 3D:', error);
      alert(`Failed to apply floor: ${error.message}`);
    } finally {
      setIsApplyingTo3D(false);
    }
  }, [meshGroupRef, currentRenovationMaterial, calibration, meshSegmentation, aiFloorOverlay]);
  
  // Handle floor measurement request from MeshyRetexturePanel
  const handleRequestFloorMeasurement = useCallback(() => {
    console.log('[PhotogrammetryViewer] Floor measurement requested');
    
    if (!meshGroupRef.current) {
      alert('⚠️ No mesh loaded. Please load a 3D scan first.');
      return;
    }
    
    try {
      // If mesh segmentation hasn't run yet, run it now (creates the blue mesh)
      if (!meshSegmentation && meshGroupRef.current) {
        console.log('[PhotogrammetryViewer] Running mesh segmentation to detect floor...');
        const segmentation = segmentMesh(meshGroupRef.current, {
          floorMaxHeight: 0.3,
          counterMinHeight: 0.7,
          counterMaxHeight: 1.2,
          ceilingMinHeight: 2.0,
        });
        setMeshSegmentation(segmentation);
        console.log('[PhotogrammetryViewer] Mesh segmented:', {
          floors: segmentation.floors.length,
          walls: segmentation.walls.length,
          ceilings: segmentation.ceilings.length,
        });
        
        // Now use the freshly created segmentation
        if (segmentation.floors?.[0]) {
          const floor = segmentation.floors[0];
          const bounds = floor.bounds;
          
          const width = bounds.max.x - bounds.min.x;
          const depth = bounds.max.z - bounds.min.z;
          const floorY = bounds.min.y;
          const centerX = (bounds.max.x + bounds.min.x) / 2;
          const centerZ = (bounds.max.z + bounds.min.z) / 2;
          
          const scaleFactor = calibration?.scaleFactor || 1.0;
          const widthMeters = width * scaleFactor;
          const depthMeters = depth * scaleFactor;
          const widthFeet = widthMeters * 3.28084;
          const depthFeet = depthMeters * 3.28084;
          
          const measurement = {
            width,
            depth,
            widthFeet,
            depthFeet,
            floorY,
            centerX,
            centerZ,
            floorPoints: [
              [bounds.min.x, floorY, bounds.min.z],
              [bounds.max.x, floorY, bounds.min.z],
              [bounds.max.x, floorY, bounds.max.z],
              [bounds.min.x, floorY, bounds.max.z],
            ] as [number, number, number][],
          };
          
          setFloorMeasurement(measurement);
          
          console.log('[PhotogrammetryViewer] Floor measured (from new segmentation):', {
            dimensions: `${widthFeet.toFixed(1)}' × ${depthFeet.toFixed(1)}'`,
            meshUnits: `${width.toFixed(2)} × ${depth.toFixed(2)}`,
            floorY,
            center: [centerX, centerZ],
          });
          
          const calibrationNote = calibration ? '' : '\n\n⚠️ Note: Room not calibrated. Measurements may be approximate.';
          alert(`✅ Floor measured!\n\nDimensions: ${widthFeet.toFixed(1)}' × ${depthFeet.toFixed(1)}'\n(${widthMeters.toFixed(2)}m × ${depthMeters.toFixed(2)}m)${calibrationNote}`);
          return;
        }
      }
      
      // Try to use existing mesh segmentation if available
      if (meshSegmentation?.floors?.[0]) {
        const floor = meshSegmentation.floors[0];
        const bounds = floor.bounds;
        
        // Calculate floor dimensions from segmented floor bounds
        const width = bounds.max.x - bounds.min.x; // mesh units
        const depth = bounds.max.z - bounds.min.z; // mesh units
        const floorY = bounds.min.y;
        const centerX = (bounds.max.x + bounds.min.x) / 2;
        const centerZ = (bounds.max.z + bounds.min.z) / 2;
        
        // Convert to real-world units using calibration if available
        const scaleFactor = calibration?.scaleFactor || 1.0;
        const widthMeters = width * scaleFactor;
        const depthMeters = depth * scaleFactor;
        const widthFeet = widthMeters * 3.28084;
        const depthFeet = depthMeters * 3.28084;
        
        const measurement = {
          width,
          depth,
          widthFeet,
          depthFeet,
          floorY,
          centerX,
          centerZ,
          floorPoints: [
            [bounds.min.x, floorY, bounds.min.z],
            [bounds.max.x, floorY, bounds.min.z],
            [bounds.max.x, floorY, bounds.max.z],
            [bounds.min.x, floorY, bounds.max.z],
          ] as [number, number, number][],
        };
        
        setFloorMeasurement(measurement);
        
        console.log('[PhotogrammetryViewer] Floor measured (from segmentation):', {
          dimensions: `${widthFeet.toFixed(1)}' × ${depthFeet.toFixed(1)}'`,
          meshUnits: `${width.toFixed(2)} × ${depth.toFixed(2)}`,
          floorY,
          center: [centerX, centerZ],
        });
        
        alert(`✅ Floor measured!\n\nDimensions: ${widthFeet.toFixed(1)}' × ${depthFeet.toFixed(1)}'\n(${widthMeters.toFixed(2)}m × ${depthMeters.toFixed(2)}m)`);
        return;
      }
      
      // Fallback: Calculate bounds from entire mesh
      console.log('[PhotogrammetryViewer] Mesh segmentation not available, using mesh bounding box');
      
      const bbox = new THREE.Box3().setFromObject(meshGroupRef.current);
      
      // Assume floor is at Y=0 or min Y
      const width = bbox.max.x - bbox.min.x;
      const depth = bbox.max.z - bbox.min.z;
      const floorY = bbox.min.y;
      const centerX = (bbox.max.x + bbox.min.x) / 2;
      const centerZ = (bbox.max.z + bbox.min.z) / 2;
      
      // Convert to real-world units using calibration if available
      const scaleFactor = calibration?.scaleFactor || 1.0;
      const widthMeters = width * scaleFactor;
      const depthMeters = depth * scaleFactor;
      const widthFeet = widthMeters * 3.28084;
      const depthFeet = depthMeters * 3.28084;
      
      const measurement = {
        width,
        depth,
        widthFeet,
        depthFeet,
        floorY,
        centerX,
        centerZ,
        floorPoints: [
          [bbox.min.x, floorY, bbox.min.z],
          [bbox.max.x, floorY, bbox.min.z],
          [bbox.max.x, floorY, bbox.max.z],
          [bbox.min.x, floorY, bbox.max.z],
        ] as [number, number, number][],
      };
      
      setFloorMeasurement(measurement);
      
      console.log('[PhotogrammetryViewer] Floor measured (from bbox):', {
        dimensions: `${widthFeet.toFixed(1)}' × ${depthFeet.toFixed(1)}'`,
        meshUnits: `${width.toFixed(2)} × ${depth.toFixed(2)}`,
        floorY,
        center: [centerX, centerZ],
      });
      
      const calibrationNote = calibration ? '' : '\n\n⚠️ Note: Room not calibrated. Measurements may be approximate.';
      alert(`✅ Floor measured!\n\nDimensions: ${widthFeet.toFixed(1)}' × ${depthFeet.toFixed(1)}'\n(${widthMeters.toFixed(2)}m × ${depthMeters.toFixed(2)}m)${calibrationNote}`);
      
    } catch (error: any) {
      console.error('[PhotogrammetryViewer] Failed to measure floor:', error);
      alert(`❌ Failed to measure floor: ${error.message}`);
    }
  }, [meshGroupRef, meshSegmentation, calibration]);
  
  // AI Texture Generation Handler (legacy - mesh overlay approach)
  const handleGenerateAITexture = useCallback(async (surfaceType: 'flooring' | 'wall' | 'ceiling') => {
    if (!meshGroupRef.current) {
      console.error('[PhotogrammetryViewer] Cannot generate AI texture: no mesh loaded');
      alert('Please load a 3D scan first');
      return;
    }
    
    setIsGeneratingAITexture(true);
    setGeneratingAISurface(surfaceType);
    
    try {
      console.log('[PhotogrammetryViewer] Generating AI texture for:', surfaceType);
      
      // ========================================================================
      // STEP 1: Scan mesh to find floor triangles and bounds FIRST
      // ========================================================================
      const allYPositions: number[] = [];
      const upwardFacingTriangles: { mesh: THREE.Mesh; faceIndex: number; centroidY: number }[] = [];
      
      meshGroupRef.current.traverse((child) => {
        if (child instanceof THREE.Mesh && child.geometry) {
          const geometry = child.geometry;
          const position = geometry.attributes.position;
          
          if (!position) return;
          
          child.updateMatrixWorld(true);
          const worldMatrix = child.matrixWorld;
          
          const vertexCount = position.count;
          const isIndexed = geometry.index !== null;
          const triangleCount = isIndexed 
            ? geometry.index!.count / 3 
            : vertexCount / 3;
          
          for (let i = 0; i < triangleCount; i++) {
            let i0, i1, i2;
            if (isIndexed) {
              i0 = geometry.index!.getX(i * 3);
              i1 = geometry.index!.getX(i * 3 + 1);
              i2 = geometry.index!.getX(i * 3 + 2);
            } else {
              i0 = i * 3;
              i1 = i * 3 + 1;
              i2 = i * 3 + 2;
            }
            
            const v0 = new THREE.Vector3(position.getX(i0), position.getY(i0), position.getZ(i0)).applyMatrix4(worldMatrix);
            const v1 = new THREE.Vector3(position.getX(i1), position.getY(i1), position.getZ(i1)).applyMatrix4(worldMatrix);
            const v2 = new THREE.Vector3(position.getX(i2), position.getY(i2), position.getZ(i2)).applyMatrix4(worldMatrix);
            
            const edge1 = new THREE.Vector3().subVectors(v1, v0);
            const edge2 = new THREE.Vector3().subVectors(v2, v0);
            const normal = new THREE.Vector3().crossVectors(edge1, edge2).normalize();
            
            if (normal.y > 0.7) {
              const centroidY = (v0.y + v1.y + v2.y) / 3;
              allYPositions.push(centroidY);
              upwardFacingTriangles.push({ mesh: child, faceIndex: i, centroidY });
            }
          }
        }
      });
      
      if (upwardFacingTriangles.length === 0) {
        throw new Error('No floor-facing triangles found in mesh');
      }
      
      // Find the ACTUAL floor plane level using histogram
      // The floor should be at a single consistent Y level (the most common lowest Y)
      const minY = Math.min(...allYPositions);
      const maxY = Math.max(...allYPositions);
      const yRange = maxY - minY;
      
      // Use 20% of the Y range as tolerance - floors in photogrammetry scans have variation
      // This captures the floor plane including slight undulations but excludes furniture
      const floorTolerance = yRange * 0.20;
      const floorThreshold = minY + floorTolerance;
      
      // Count how many triangles would be captured at various thresholds
      const countAtThreshold = (thresh: number) => 
        upwardFacingTriangles.filter(t => t.centroidY <= thresh).length;
      
      console.log('[PhotogrammetryViewer] Floor detection:', {
        minY: minY.toFixed(3),
        maxY: maxY.toFixed(3),
        yRange: yRange.toFixed(3),
        tolerance: floorTolerance.toFixed(3),
        threshold: floorThreshold.toFixed(3),
        trianglesAt10pct: countAtThreshold(minY + yRange * 0.10),
        trianglesAt20pct: countAtThreshold(minY + yRange * 0.20),
        trianglesAt30pct: countAtThreshold(minY + yRange * 0.30),
        totalUpward: upwardFacingTriangles.length,
      });
      
      // Calculate floor bounds in mesh units
      let floorMinX = Infinity, floorMaxX = -Infinity;
      let floorMinZ = Infinity, floorMaxZ = -Infinity;
      
      upwardFacingTriangles.forEach(({ mesh, faceIndex, centroidY }) => {
        if (centroidY > floorThreshold) return;
        
        const geometry = mesh.geometry;
        const position = geometry.attributes.position;
        const isIndexed = geometry.index !== null;
        
        let i0, i1, i2;
        if (isIndexed) {
          i0 = geometry.index!.getX(faceIndex * 3);
          i1 = geometry.index!.getX(faceIndex * 3 + 1);
          i2 = geometry.index!.getX(faceIndex * 3 + 2);
        } else {
          i0 = faceIndex * 3;
          i1 = faceIndex * 3 + 1;
          i2 = faceIndex * 3 + 2;
        }
        
        mesh.updateMatrixWorld(true);
        const wm = mesh.matrixWorld;
        
        const v0 = new THREE.Vector3(position.getX(i0), position.getY(i0), position.getZ(i0)).applyMatrix4(wm);
        const v1 = new THREE.Vector3(position.getX(i1), position.getY(i1), position.getZ(i1)).applyMatrix4(wm);
        const v2 = new THREE.Vector3(position.getX(i2), position.getY(i2), position.getZ(i2)).applyMatrix4(wm);
        
        [v0, v1, v2].forEach(v => {
          floorMinX = Math.min(floorMinX, v.x);
          floorMaxX = Math.max(floorMaxX, v.x);
          floorMinZ = Math.min(floorMinZ, v.z);
          floorMaxZ = Math.max(floorMaxZ, v.z);
        });
      });
      
      const floorWidthMesh = floorMaxX - floorMinX;
      const floorDepthMesh = floorMaxZ - floorMinZ;
      
      // Detect room orientation - planks should run along the LONGER dimension
      // Calculate principal axes of the floor using PCA-like approach
      let floorCenterX = (floorMinX + floorMaxX) / 2;
      let floorCenterZ = (floorMinZ + floorMaxZ) / 2;
      
      // Determine rotation angle based on room aspect ratio
      // If room is rotated, we need to align planks with the longest wall
      const roomRotation = floorWidthMesh > floorDepthMesh ? 0 : Math.PI / 2;
      console.log('[PhotogrammetryViewer] Room orientation:', {
        widthMesh: floorWidthMesh.toFixed(2),
        depthMesh: floorDepthMesh.toFixed(2),
        planksAlongAxis: floorWidthMesh > floorDepthMesh ? 'X (width)' : 'Z (depth)',
        rotationDegrees: (roomRotation * 180 / Math.PI).toFixed(0),
      });
      
      // ========================================================================
      // STEP 2: Apply calibration to get REAL-WORLD dimensions
      // ========================================================================
      // calibration.scaleFactor = mesh units → inches
      // To get meters: meshUnits * scaleFactor / 39.37
      const inchesToMeters = 0.0254;
      const scaleFactor = calibration?.scaleFactor || 1;
      
      const floorWidthMeters = floorWidthMesh * scaleFactor * inchesToMeters;
      const floorDepthMeters = floorDepthMesh * scaleFactor * inchesToMeters;
      const floorAreaMeters = floorWidthMeters * floorDepthMeters;
      
      // Standard hardwood plank dimensions
      const PLANK_WIDTH_METERS = 0.127; // 5 inches
      const PLANK_LENGTH_METERS = 1.83; // 6 feet
      
      // Calculate exact plank count needed
      const planksAcrossWidth = Math.ceil(floorDepthMeters / PLANK_WIDTH_METERS);
      const planksAcrossLength = Math.ceil(floorWidthMeters / PLANK_LENGTH_METERS);
      
      console.log('[PhotogrammetryViewer] Floor dimensions from calibration:', {
        meshBounds: `${floorWidthMesh.toFixed(2)} x ${floorDepthMesh.toFixed(2)} mesh units`,
        scaleFactor: scaleFactor.toFixed(4),
        realDimensions: `${floorWidthMeters.toFixed(2)}m x ${floorDepthMeters.toFixed(2)}m`,
        area: `${floorAreaMeters.toFixed(1)}m²`,
        planksNeeded: `${planksAcrossWidth} planks wide × ${planksAcrossLength} rows`,
        calibrated: !!calibration,
      });
      
      // ========================================================================
      // STEP 3: Generate AI texture with exact dimensions
      // ========================================================================
      const segmentType: 'floor' | 'wall' | 'ceiling' | 'counter' = 'floor';
      const renovationType: 'flooring' | 'paint' | 'countertop' = 'flooring';
      const renovationOption = 'hardwood';
      
      const textureRequest: TextureGenerationRequest = {
        segmentImage: 'data:image/jpeg;base64,',
        segmentType,
        renovationType,
        renovationOption,
        dimensions: {
          width: floorWidthMeters,
          height: floorDepthMeters,
          area: floorAreaMeters,
        },
        customPrompt: `Generate a photograph of classic medium-brown oak hardwood floor planks from directly above.
The planks run horizontally from left to right, perfectly parallel to each other.
Each plank is about 5 inches wide with warm honey-brown to medium oak color.
Show rich natural wood grain patterns running lengthwise along each plank.
Include realistic details: subtle knots, natural color variations between planks, thin dark gaps between boards.
The wood should look warm and polished, like a classic American hardwood floor.
Top-down orthographic view only - no perspective, no shadows, no reflections.
Fill the entire image with just the floor planks - no edges, no furniture, no objects.
Make sure all planks are perfectly horizontal and evenly spaced.`,
        // Note: Plank count calculated for estimation: ${planksAcrossWidth} planks across ${floorDepthMeters.toFixed(2)}m
      };
      
      console.log('[PhotogrammetryViewer] Calling AI texture API with exact dimensions...');
      const generatedTexture = await generateAITexture(textureRequest);
      console.log('[PhotogrammetryViewer] AI texture generated:', generatedTexture);
      
      if (!generatedTexture.textureDataUrl && !generatedTexture.textureUrl) {
        throw new Error('No texture image was generated. The AI returned: ' + (generatedTexture.description || 'no response'));
      }
      
      // ========================================================================
      // STEP 4: Load texture and build floor overlay geometry
      // ========================================================================
      console.log('[PhotogrammetryViewer] Loading texture into THREE.js...');
      const threeTexture = await loadTextureForThreeJS(generatedTexture);
      console.log('[PhotogrammetryViewer] Texture loaded, applying to floor only...');
      
      if (!meshGroupRef.current) {
        throw new Error('Mesh reference lost during texture generation');
      }
      
      // Build floor geometry with proper planar UV projection
      const floorVertices: number[] = [];
      const floorUVs: number[] = [];
      let floorTriangleCount = 0;
      
      // Build geometry with planar UV projection using already-computed bounds
      upwardFacingTriangles.forEach(({ mesh, faceIndex, centroidY }) => {
        if (centroidY > floorThreshold) return; // Not floor level
        
        const geometry = mesh.geometry;
        const position = geometry.attributes.position;
        const isIndexed = geometry.index !== null;
        
        let i0, i1, i2;
        if (isIndexed) {
          i0 = geometry.index!.getX(faceIndex * 3);
          i1 = geometry.index!.getX(faceIndex * 3 + 1);
          i2 = geometry.index!.getX(faceIndex * 3 + 2);
        } else {
          i0 = faceIndex * 3;
          i1 = faceIndex * 3 + 1;
          i2 = faceIndex * 3 + 2;
        }
        
        mesh.updateMatrixWorld(true);
        const wm = mesh.matrixWorld;
        
        const v0 = new THREE.Vector3(position.getX(i0), position.getY(i0), position.getZ(i0)).applyMatrix4(wm);
        const v1 = new THREE.Vector3(position.getX(i1), position.getY(i1), position.getZ(i1)).applyMatrix4(wm);
        const v2 = new THREE.Vector3(position.getX(i2), position.getY(i2), position.getZ(i2)).applyMatrix4(wm);
        
        // Add vertices with Y offset to prevent z-fighting (0.02 units above original)
        const yOffset = 0.02;
        floorVertices.push(v0.x, v0.y + yOffset, v0.z);
        floorVertices.push(v1.x, v1.y + yOffset, v1.z);
        floorVertices.push(v2.x, v2.y + yOffset, v2.z);
        
        // Calculate planar UV projection with room-aligned orientation
        // Planks run along the longer dimension for natural look
        [v0, v1, v2].forEach(v => {
          // Normalize to 0-1 range based on floor bounds
          let localX = (v.x - floorMinX) / floorWidthMesh;
          let localZ = (v.z - floorMinZ) / floorDepthMesh;
          
          // If room is taller than wide, rotate UVs 90 degrees so planks run along the longer axis
          let u, vCoord;
          if (roomRotation > 0) {
            // Swap and flip for 90-degree rotation
            u = localZ;
            vCoord = 1 - localX;
          } else {
            u = localX;
            vCoord = localZ;
          }
          
          floorUVs.push(u, vCoord);
        });
        
        floorTriangleCount++;
      });
      
      console.log(`[PhotogrammetryViewer] Floor geometry: ${floorTriangleCount} triangles at floor level`);
      
      if (floorTriangleCount === 0) {
        throw new Error('No triangles at floor level found');
      }
      
      // ========================================================================
      // STEP 5: Create floor overlay mesh with AI texture
      // ========================================================================
      const floorGeometry = new THREE.BufferGeometry();
      floorGeometry.setAttribute('position', new THREE.Float32BufferAttribute(floorVertices, 3));
      floorGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(floorUVs, 2));
      floorGeometry.computeVertexNormals();
      
      // Configure texture for proper tiling
      threeTexture.wrapS = THREE.RepeatWrapping;
      threeTexture.wrapT = THREE.RepeatWrapping;
      threeTexture.repeat.set(1, 1); // 1:1 mapping, UVs already normalized
      threeTexture.needsUpdate = true;
      
      // Use MeshBasicMaterial with polygon offset for z-fighting prevention
      const floorMaterial = new THREE.MeshBasicMaterial({
        map: threeTexture,
        side: THREE.DoubleSide,
        transparent: false,
        depthWrite: true,
        depthTest: true,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      });
      
      // Remove any existing floor overlay
      const existingOverlay = meshGroupRef.current.getObjectByName('AI_FLOOR_OVERLAY');
      if (existingOverlay) {
        meshGroupRef.current.remove(existingOverlay);
        console.log('[PhotogrammetryViewer] Removed existing floor overlay');
      }
      
      const floorOverlay = new THREE.Mesh(floorGeometry, floorMaterial);
      floorOverlay.name = 'AI_FLOOR_OVERLAY';
      floorOverlay.userData.isAIOverlay = true;
      floorOverlay.userData.hasAITexture = true;
      floorOverlay.renderOrder = 999; // Render on top
      floorOverlay.frustumCulled = false; // Always render
      
      // Store in state so R3F can render it declaratively
      setAiFloorOverlay(floorOverlay);
      
      // Debug: log overlay details
      console.log('[PhotogrammetryViewer] Floor overlay created:', {
        vertexCount: floorVertices.length / 3,
        uvCount: floorUVs.length / 2,
        triangleCount: floorTriangleCount,
        textureSize: `${threeTexture.image?.width || 'N/A'}x${threeTexture.image?.height || 'N/A'}`,
        materialHasMap: !!floorMaterial.map,
        overlayPosition: floorOverlay.position.toArray(),
      });
      
      console.log(`[PhotogrammetryViewer] ✅ AI floor texture applied! ${floorTriangleCount} triangles at floor level (Y < ${floorThreshold.toFixed(2)})`);
      console.log(`[PhotogrammetryViewer] Floor dimensions: ${floorWidthMeters.toFixed(2)}m × ${floorDepthMeters.toFixed(2)}m = ${floorAreaMeters.toFixed(1)}m²`);
      
      // Force a state update to trigger re-render
      setSelectedMaterials(prev => {
        const newSelection = { ...prev };
        if (surfaceType === 'flooring') {
          newSelection.flooringId = 'ai-generated';
        } else if (surfaceType === 'wall') {
          newSelection.wallId = 'ai-generated';
        } else if (surfaceType === 'ceiling') {
          newSelection.ceilingId = 'ai-generated';
        }
        return newSelection;
      });
      
    } catch (error: any) {
      console.error('[PhotogrammetryViewer] AI texture generation failed:', error);
      alert(`Failed to generate AI texture: ${error.message || error}`);
    } finally {
      setIsGeneratingAITexture(false);
      setGeneratingAISurface(null);
    }
  }, [meshSegmentation, meshGroupRef, calibration]);
  
  // Handle mesh loaded callback - analyze the mesh for overlay positioning
  const handleMeshLoaded = useCallback((meshGroup: THREE.Group) => {
    console.log('[PhotogrammetryViewer] Mesh loaded callback triggered');
    console.log('[PhotogrammetryViewer] Mesh group position:', meshGroup.position.toArray());
    console.log('[PhotogrammetryViewer] Mesh group scale:', meshGroup.scale.toArray());
    
    // Store reference for RenovationPreviewSystem
    meshGroupRef.current = meshGroup;
    
    try {
      // Ensure world matrix is up to date
      meshGroup.updateMatrixWorld(true);
      
      const analysis = analyzeMesh(meshGroup);
      console.log('[PhotogrammetryViewer] Mesh analysis result:', {
        boundsCenter: [analysis.bounds.center.x.toFixed(2), analysis.bounds.center.y.toFixed(2), analysis.bounds.center.z.toFixed(2)],
        boundsSize: [analysis.bounds.size.x.toFixed(2), analysis.bounds.size.y.toFixed(2), analysis.bounds.size.z.toFixed(2)],
        zonesCount: analysis.roomZones.length,
      });
      
      setMeshAnalysis(analysis);
    } catch (error) {
      console.error('[PhotogrammetryViewer] Mesh analysis failed:', error);
    }
  }, []);
  
  // Adjust renovation positions when mesh analysis or renovations change
  useEffect(() => {
    if (meshAnalysis && renovationDetectionState?.renovations?.length) {
      console.log('[PhotogrammetryViewer] Adjusting renovation positions to mesh...');
      const adjusted = adjustRenovationsToMesh(
        renovationDetectionState.renovations,
        meshAnalysis
      );
      setAdjustedRenovations(adjusted);
      console.log('[PhotogrammetryViewer] Adjusted', adjusted.length, 'renovations to mesh bounds');
    } else if (renovationDetectionState?.renovations) {
      // Use original positions if no mesh analysis available
      setAdjustedRenovations(renovationDetectionState.renovations);
    }
  }, [meshAnalysis, renovationDetectionState?.renovations]);
  
  // Rotate model by 90 degrees on specified axis
  const rotateModel = useCallback((axis: 'x' | 'y' | 'z', direction: 1 | -1 = 1) => {
    setModelRotation(prev => {
      const delta = (Math.PI / 2) * direction;
      return [
        axis === 'x' ? prev[0] + delta : prev[0],
        axis === 'y' ? prev[1] + delta : prev[1],
        axis === 'z' ? prev[2] + delta : prev[2],
      ];
    });
  }, []);
  
  // Handle mouse/trackpad events for model rotation
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const handleMouseDown = (e: MouseEvent) => {
      // Shift+click or right-click for model rotation
      if (e.shiftKey || e.button === 2) {
        setIsRotatingModel(true);
        lastMousePos.current = { x: e.clientX, y: e.clientY };
        e.preventDefault();
      }
    };
    
    const handleMouseMove = (e: MouseEvent) => {
      if (isRotatingModel && lastMousePos.current) {
        const deltaX = e.clientX - lastMousePos.current.x;
        const deltaY = e.clientY - lastMousePos.current.y;
        
        // Rotate model based on mouse movement
        // Horizontal drag = Y rotation, Vertical drag = X rotation
        const sensitivity = 0.01;
        setModelRotation(prev => [
          prev[0] + deltaY * sensitivity,
          prev[1] + deltaX * sensitivity,
          prev[2]
        ]);
        
        lastMousePos.current = { x: e.clientX, y: e.clientY };
      }
    };
    
    const handleMouseUp = () => {
      setIsRotatingModel(false);
      lastMousePos.current = null;
    };
    
    // Two-finger trackpad gesture (wheel with ctrlKey on macOS)
    const handleWheel = (e: WheelEvent) => {
      // On macOS, pinch-to-zoom fires wheel events with ctrlKey
      // Two-finger swipe without ctrl = pan/scroll, we want Shift+scroll for rotation
      if (e.shiftKey) {
        e.preventDefault();
        const sensitivity = 0.005;
        setModelRotation(prev => [
          prev[0] + e.deltaY * sensitivity,
          prev[1] + e.deltaX * sensitivity,
          prev[2]
        ]);
      }
    };
    
    const handleContextMenu = (e: MouseEvent) => {
      // Prevent context menu when right-clicking to rotate
      if (isRotatingModel) {
        e.preventDefault();
      }
    };
    
    canvas.addEventListener('mousedown', handleMouseDown);
    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseup', handleMouseUp);
    canvas.addEventListener('mouseleave', handleMouseUp);
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    canvas.addEventListener('contextmenu', handleContextMenu);
    
    return () => {
      canvas.removeEventListener('mousedown', handleMouseDown);
      canvas.removeEventListener('mousemove', handleMouseMove);
      canvas.removeEventListener('mouseup', handleMouseUp);
      canvas.removeEventListener('mouseleave', handleMouseUp);
      canvas.removeEventListener('wheel', handleWheel);
      canvas.removeEventListener('contextmenu', handleContextMenu);
    };
  }, [isRotatingModel]);
  
  // Manual calibration click handler - defined before handleMeshClick to avoid hoisting issues
  const handleManualCalibrationClick = useCallback((point: THREE.Vector3) => {
    if (!manualCalibrationMode) return;
    
    setManualCalibrationPoints(prev => {
      const newPoints = [...prev, point.clone()];
      if (newPoints.length === 2) {
        // We have both points, wait for user to enter distance
        console.log('[Calibration] Two points selected, waiting for distance input');
      }
      return newPoints;
    });
  }, [manualCalibrationMode]);
  
  const handleMeshClick = useCallback((point: THREE.Vector3, normal: THREE.Vector3) => {
    // Handle measured hole cutter mode (highest priority)
    if (measuredHoleCutter.isActive) {
      console.log('[PhotogrammetryViewer] Measured hole cutter click:', {
        point: point.toArray(),
        normal: normal.toArray()
      });
      measuredHoleCutter.addPoint(point, normal);
      return;
    }
    
    // Handle opening placement mode for mesh editor
    if (openingPlacementMode) {
      console.log('[PhotogrammetryViewer] Opening placement click:', {
        point: point.toArray(),
        normal: normal.toArray(),
        type: openingPlacementMode
      });
      setPlacedPosition(point.clone());
      setPlacedNormal(normal.clone());
      setOpeningPlacementMode(null); // Exit placement mode after clicking
      return;
    }
    
    // Handle manual calibration mode
    if (manualCalibrationMode) {
      handleManualCalibrationClick(point);
      return;
    }
    
    if (!state.measuringMode) return;
    
    setState(prev => {
      const newPoints = [...prev.pendingPoints, point.clone()];
      
      if (newPoints.length === 2) {
        // Complete measurement
        const meshDistance = newPoints[0].distanceTo(newPoints[1]);
        
        // Apply calibration if available
        let displayValue = meshDistance;
        let displayUnit = 'm';
        
        if (calibration && calibration.success) {
          const calibrated = getCalibratedDistance(meshDistance, calibration, 'feet');
          displayValue = calibrated.value;
          displayUnit = calibrated.unit;
        }
        
        const measurement: Measurement = {
          id: `m-${Date.now()}`,
          type: 'distance',
          points: newPoints,
          value: displayValue,
          unit: displayUnit,
        };
        
        onMeasure?.(measurement);
        
        return {
          ...prev,
          measurements: [...prev.measurements, measurement],
          pendingPoints: [],
        };
      }
      
      return { ...prev, pendingPoints: newPoints };
    });
  }, [state.measuringMode, onMeasure, manualCalibrationMode, handleManualCalibrationClick, calibration, openingPlacementMode, measuredHoleCutter.isActive, measuredHoleCutter.addPoint]);
  
  const handleNavigate = useCallback((viewpointId: string) => {
    setState(prev => ({
      ...prev,
      currentViewpoint: viewpointId,
    }));
  }, []);
  
  const toggleMeasureMode = useCallback(() => {
    setState(prev => ({
      ...prev,
      measuringMode: !prev.measuringMode,
      pendingPoints: [],
    }));
  }, []);
  
  const clearMeasurements = useCallback(() => {
    setState(prev => ({
      ...prev,
      measurements: [],
      pendingPoints: [],
    }));
  }, []);
  
  const cycleMode = useCallback(() => {
    setState(prev => {
      const modes: Array<'orbit' | 'walkthrough' | 'firstPerson'> = ['orbit', 'firstPerson', 'walkthrough'];
      const currentIndex = modes.indexOf(prev.mode);
      const nextMode = modes[(currentIndex + 1) % modes.length];
      return { ...prev, mode: nextMode };
    });
  }, []);
  
  const setMode = useCallback((mode: 'orbit' | 'walkthrough' | 'firstPerson') => {
    setState(prev => ({ ...prev, mode }));
  }, []);
  
  // Renovation handlers
  const handleRenovationClick = useCallback((renovation: DetectedRenovation) => {
    setSelectedRenovation(renovation);
    setShowDetailsModal(true);
    onRenovationSelect?.(renovation);
  }, [onRenovationSelect]);
  
  const handleRenovationHover = useCallback((renovationId: string | null) => {
    setHoveredRenovationId(renovationId);
  }, []);
  
  const handleCloseDetailsModal = useCallback(() => {
    setShowDetailsModal(false);
    setSelectedRenovation(null);
    onRenovationSelect?.(null);
  }, [onRenovationSelect]);
  
  const handleAddToMarketplace = useCallback(() => {
    if (selectedRenovation) {
      setShowDetailsModal(false);
      setShowMarketplaceModal(true);
      onAddToMarketplace?.(selectedRenovation);
    }
  }, [selectedRenovation, onAddToMarketplace]);
  
  const handleARPreview = useCallback(() => {
    if (selectedRenovation) {
      setShowDetailsModal(false);
      setShowARPreview(true);
      onARPreview?.(selectedRenovation);
    }
  }, [selectedRenovation, onARPreview]);
  
  const handleCloseMarketplaceModal = useCallback(() => {
    setShowMarketplaceModal(false);
  }, []);
  
  const handleCloseARPreview = useCallback(() => {
    setShowARPreview(false);
  }, []);
  
  const handleMarketplaceSuccess = useCallback(() => {
    setShowMarketplaceModal(false);
    // Could show a success toast here
  }, []);
  
  // Calibration handlers
  const handleStartManualCalibration = useCallback(() => {
    setManualCalibrationMode(true);
    setManualCalibrationPoints([]);
    setManualCalibrationDistance('');
    setState(prev => ({ ...prev, measuringMode: false }));
  }, []);
  
  const handleCancelCalibration = useCallback(() => {
    setManualCalibrationMode(false);
    setManualCalibrationPoints([]);
    setManualCalibrationDistance('');
  }, []);
  
  const handleConfirmManualCalibration = useCallback(() => {
    if (manualCalibrationPoints.length === 2 && manualCalibrationDistance) {
      const distanceInches = parseFloat(manualCalibrationDistance);
      if (!isNaN(distanceInches) && distanceInches > 0) {
        const result = manualCalibrate(
          manualCalibrationPoints[0],
          manualCalibrationPoints[1],
          distanceInches
        );
        setCalibration(result);
        setManualCalibrationMode(false);
        setManualCalibrationPoints([]);
        setManualCalibrationDistance('');
        console.log('[Calibration] Manual calibration complete:', result);
      }
    }
  }, [manualCalibrationPoints, manualCalibrationDistance]);
  
  // Auto-calibration handler - called when scene is captured
  const handleSceneCaptured = useCallback(async (imageData: string) => {
    console.log('[Auto-Calibration] 🤖 Starting AI object detection');
    console.log('[Auto-Calibration] Scan ID:', scanId);
    
    try {
      setAutoCalibrationStatus('� Loading original scan photos...');
      
      // Send image to backend for AI analysis
      // Backend will try to use original scan photos first (much better quality)
      console.log('[Auto-Calibration] 📤 Sending request to /api/calibration/detect-objects');
      console.log('[Auto-Calibration] Backend will prefer original photos over 3D render');
      const startTime = Date.now();
      
      const response = await fetch('/api/calibration/detect-objects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageData, // Fallback: 3D render screenshot
          scanId,    // Used to locate original photos
          useOriginalImages: true // Prefer original photos
        })
      });
      
      const elapsedTime = Date.now() - startTime;
      console.log(`[Auto-Calibration] ⏱️  API response received in ${elapsedTime}ms`);
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error('[Auto-Calibration] ❌ API error:', response.status, errorText);
        throw new Error(`API error: ${response.status}`);
      }
      
      setAutoCalibrationStatus('🔍 AI analyzing photos...');
      
      const result = await response.json();
      console.log('[Auto-Calibration] 📊 AI detection result:', {
        success: result.success,
        objectCount: result.detectedObjects?.length || 0,
        roomType: result.roomType,
        confidence: result.overallConfidence,
        usedOriginalImages: result.usedOriginalImages
      });
      console.log('[Auto-Calibration] Detected objects:', result.detectedObjects);
      
      if (result.usedOriginalImages) {
        console.log('[Auto-Calibration] ✅ Used original scan photos (high quality)');
      } else {
        console.log('[Auto-Calibration] ⚠️  Used 3D render screenshot (lower quality)');
      }
      
      if (result.success && result.detectedObjects?.length > 0) {
        // Find the best calibration object (highest confidence with known dimensions)
        const bestObject = result.detectedObjects[0];
        console.log('[Auto-Calibration] 🎯 Best object selected:', {
          name: bestObject.name,
          type: bestObject.type,
          confidence: bestObject.confidence,
          knownDimension: bestObject.knownDimension,
          boundingBox: bestObject.boundingBox
        });
        
        setAutoCalibrationStatus(`✓ Found: ${bestObject.name} (${bestObject.confidence}% confidence)`);
        
        // Calculate scale factor from the detected object
        const knownDimensionInches = bestObject.knownDimension?.value || 0;
        
        console.log('[Auto-Calibration] 📏 Known dimension:', knownDimensionInches, 'inches');
        console.log('[Auto-Calibration] Mesh analysis:', meshAnalysis ? 'Available' : 'Missing');
        
        if (knownDimensionInches > 0 && meshAnalysis) {
          // Use mesh size to estimate scale factor
          const meshSize = meshAnalysis.bounds.size;
          const avgMeshDimension = (meshSize.x + meshSize.y + meshSize.z) / 3;
          
          console.log('[Auto-Calibration] Mesh dimensions:', {
            x: meshSize.x.toFixed(3),
            y: meshSize.y.toFixed(3),
            z: meshSize.z.toFixed(3),
            avg: avgMeshDimension.toFixed(3)
          });
          
          // Estimate: if the detected object takes up roughly 1/10 of the scene
          const estimatedObjectMeshSize = avgMeshDimension * (bestObject.boundingBox?.width || 0.1);
          const scaleFactor = knownDimensionInches / estimatedObjectMeshSize;
          
          console.log('[Auto-Calibration] 🧮 Calculation:', {
            bboxWidth: bestObject.boundingBox?.width,
            estimatedMeshSize: estimatedObjectMeshSize.toFixed(3),
            scaleFactor: scaleFactor.toFixed(3),
            formula: `${knownDimensionInches} inches / ${estimatedObjectMeshSize.toFixed(3)} mesh units`
          });
          
          const calibrationResult: CalibrationResult = {
            success: true,
            scaleFactor,
            unit: 'inches',
            confidenceScore: bestObject.confidence / 100,
            referenceObject: {
              name: bestObject.name,
              knownDimension: knownDimensionInches,
              unit: 'inches'
            }
          };
          
          setCalibration(calibrationResult);
          setAutoCalibrationStatus(`✅ Calibrated using ${bestObject.name}`);
          console.log('[Auto-Calibration] ✅ SUCCESS! Calibration complete:', calibrationResult);
          console.log('[Auto-Calibration] 1 mesh unit =', (1 * scaleFactor).toFixed(2), 'inches');
          
          // Keep success message visible longer
          setTimeout(() => setAutoCalibrationStatus(''), 5000);
        } else {
          console.error('[Auto-Calibration] ❌ FAILED: Missing required data', {
            hasKnownDimension: knownDimensionInches > 0,
            hasMeshAnalysis: !!meshAnalysis
          });
          setAutoCalibrationStatus('⚠️  Could not determine scale. Try manual calibration.');
          setTimeout(() => {
            setAutoCalibrationStatus('');
            handleStartManualCalibration();
          }, 3000);
        }
      } else {
        console.warn('[Auto-Calibration] ⚠️  No objects detected or API returned failure');
        console.warn('[Auto-Calibration] 💡 To improve detection:');
        console.warn('  • Rotate camera to show outlets, switches, or door frames');
        console.warn('  • Ensure objects are clearly visible and well-lit');
        console.warn('  • Look for standard fixtures: outlets (4.5"), doors (80"), counters (36")');
        console.warn('  • Try zooming in on a specific fixture');
        
        setAutoCalibrationStatus('⚠️  No recognizable objects found. Point camera at outlets, doors, or appliances and try again.');
        setTimeout(() => {
          setAutoCalibrationStatus('');
          handleStartManualCalibration();
        }, 5000); // Give more time to read the message
      }
    } catch (error) {
      console.error('[Auto-Calibration] ❌ EXCEPTION:', error);
      console.error('[Auto-Calibration] Error details:', {
        message: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined
      });
      
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      setAutoCalibrationStatus(`❌ Error: ${errorMsg}`);
      
      setTimeout(() => {
        setAutoCalibrationStatus('');
        console.log('[Auto-Calibration] Falling back to manual calibration');
        handleStartManualCalibration();
      }, 3000);
    } finally {
      setIsCalibrating(false);
      console.log('[Auto-Calibration] Process complete (calibrating flag reset)');
    }
  }, [scanId, meshAnalysis, handleStartManualCalibration]);
  
  // Handle scene capture complete
  const handleSceneCaptureComplete = useCallback(() => {
    setTriggerSceneCapture(false);
  }, []);
  
  // Get calibrated measurement display
  const getDisplayMeasurement = useCallback((meshDistance: number): { value: number; unit: string } => {
    if (calibration && calibration.success) {
      const calibrated = getCalibratedDistance(meshDistance, calibration, 'feet');
      return { value: calibrated.value, unit: calibrated.unit };
    }
    // Fallback to raw mesh units
    return { value: meshDistance, unit: 'm (uncalibrated)' };
  }, [calibration]);
  
  const currentViewpoint = state.currentViewpoint && navigation
    ? navigation.viewpointMap.get(state.currentViewpoint) || null
    : null;
  
  // ============================================================================
  // Download GLB
  // Export the current photogrammetry scan as a .glb file
  // ============================================================================
  const handleDownloadGLB = useCallback(async () => {
    if (!meshGroupRef.current || !sceneRef.current) {
      alert('No 3D model loaded to export');
      return;
    }
    
    try {
      console.log('[PhotogrammetryViewer] Starting GLB export...');
      
      // Create a GLTFExporter instance
      const exporter = new GLTFExporter();
      
      // Clone the mesh group to avoid modifying the scene
      const exportGroup = meshGroupRef.current.clone(true);
      
      // If there's an AI floor overlay, include it
      if (aiFloorOverlay) {
        exportGroup.add(aiFloorOverlay.clone(true));
      }
      
      // Include any placed objects
      if (placedObjects.length > 0) {
        placedObjects.forEach(obj => {
          sceneRef.current?.traverse((child) => {
            if (child.userData.placedObjectId === obj.id) {
              exportGroup.add(child.clone(true));
            }
          });
        });
      }
      
      // Export as GLB (binary format)
      exporter.parse(
        exportGroup,
        (result) => {
          // Result is an ArrayBuffer
          const blob = new Blob([result as ArrayBuffer], { type: 'application/octet-stream' });
          const url = URL.createObjectURL(blob);
          
          // Create download link
          const link = document.createElement('a');
          link.href = url;
          link.download = `scan-${scanId}-${Date.now()}.glb`;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          
          // Clean up
          URL.revokeObjectURL(url);
          
          console.log('[PhotogrammetryViewer] ✅ GLB exported successfully');
        },
        (error) => {
          console.error('[PhotogrammetryViewer] GLB export failed:', error);
          alert(`Failed to export GLB: ${error}`);
        },
        {
          binary: true, // Export as GLB (binary) instead of GLTF (JSON)
          onlyVisible: true,
          embedImages: true,
        }
      );
      
    } catch (error: any) {
      console.error('[PhotogrammetryViewer] GLB export error:', error);
      alert(`Export failed: ${error.message || error}`);
    }
  }, [meshGroupRef, sceneRef, aiFloorOverlay, placedObjects, scanId]);
  
  return (
    <div ref={canvasRef} className={`relative w-full h-full ${className}`}>
      {/* 3D Canvas */}
      <Canvas
        shadows
        gl={{
          antialias: true,
          preserveDrawingBuffer: true,
          powerPreference: "high-performance"
        }}
        onCreated={({ gl }) => {
          gl.toneMapping = THREE.ACESFilmicToneMapping;
          gl.toneMappingExposure = 1;
          
          // Handle context loss
          const canvas = gl.domElement;
          canvas.addEventListener('webglcontextlost', (event) => {
            event.preventDefault();
            console.error('[WebGL] Context lost!');
          });
          
          canvas.addEventListener('webglcontextrestored', () => {
            console.log('[WebGL] Context restored');
          });
        }}
      >
        <PerspectiveCamera makeDefault position={[10, 10, 10]} fov={75} />
        
        {/* Lighting */}
        <ambientLight intensity={0.6} />
        <directionalLight 
          position={[10, 10, 5]} 
          intensity={1.2} 
          castShadow 
          shadow-mapSize={[2048, 2048]}
        />
        <directionalLight position={[-10, 10, -5]} intensity={0.7} />
        <directionalLight position={[0, -5, 0]} intensity={0.3} />
        <hemisphereLight intensity={0.4} groundColor="#444444" />
        
        {/* Grid and axes helpers */}
        <gridHelper args={[50, 50]} />
        <axesHelper args={[10]} />
        
        {/* Mesh */}
        <Suspense fallback={<Loader />}>
          <MeshDisplay 
            url={currentMeshUrl || meshUrl} 
            mtlUrl={mtlUrl}
            textureUrl={textureUrl}
            fileType={fileType}
            onClick={handleMeshClick}
            onPointerMove={measuredHoleCutter.isActive ? 
              (point, normal) => measuredHoleCutter.updateMousePosition(point, normal) : 
              undefined
            }
            rotation={modelRotation}
            onMeshLoaded={handleMeshLoaded}
          />
        </Suspense>
        
        {/* Placed Generated Objects */}
        {placedObjects.length > 0 && (
          <Suspense fallback={null}>
            {placedObjects.map((obj) => (
              <PlacedObject
                key={obj.id}
                data={obj}
                isSelected={selectedObjectId === obj.id}
                onSelect={() => setSelectedObjectId(obj.id)}
                transformMode={selectedObjectId === obj.id ? transformMode : undefined}
                onPositionChange={(pos) => updateObjectPosition(obj.id, pos)}
                onRotationChange={(rot) => updateObjectRotation(obj.id, rot)}
                onScaleChange={(scl) => updateObjectScale(obj.id, scl)}
              />
            ))}
          </Suspense>
        )}
        
        {/* AI Floor Overlay - rendered with same rotation as mesh */}
        {aiFloorOverlay && (
          <group rotation={modelRotation}>
            <primitive object={aiFloorOverlay} />
          </group>
        )}
        
        {/* Navigation arrows */}
        {state.mode === 'walkthrough' && navigation && state.currentViewpoint && (
          <ViewpointNavigation
            navigation={navigation}
            currentViewpoint={state.currentViewpoint}
            onNavigate={handleNavigate}
          />
        )}
        
        {/* Measurement markers */}
        <MeasurementMarkers
          measurements={state.measurements}
          pendingPoints={state.pendingPoints}
        />
        
        {/* Measured Hole Cutter Overlay */}
        <MeasuredHoleCutterOverlay
          isActive={measuredHoleCutter.isActive}
          calibration={calibration}
          polygon={measuredHoleCutter.polygon}
          currentMousePosition={measuredHoleCutter.currentMousePosition}
          previewDistance={measuredHoleCutter.previewDistance}
        />
        
        {/* Renovation Detection Markers - uses mesh-adjusted positions, wrapped in same rotation as mesh */}
        {showRenovationMarkers && adjustedRenovations.length > 0 && (
          <group rotation={modelRotation}>
            <RenovationOverlay
              renovations={adjustedRenovations}
              selectedRenovationId={selectedRenovation?.id || null}
              hoveredRenovationId={hoveredRenovationId}
              showZones={true}
              onRenovationClick={handleRenovationClick}
              onRenovationHover={handleRenovationHover}
            />
          </group>
        )}
        
        {/* Camera controller */}
        <CameraController
          mode={state.mode}
          viewpoint={currentViewpoint || undefined}
        />
        
        {/* Controls based on mode */}
        {state.mode === 'orbit' && (
          <OrbitControls
            ref={controlsRef}
            enablePan={true}
            enableZoom={true}
            enableRotate={true}
            minDistance={0.5}
            maxDistance={100}
            target={[0, 0, 0]}
            minPolarAngle={0}
            maxPolarAngle={Math.PI}
          />
        )}
        
        {/* First Person Controls */}
        <FirstPersonControls enabled={state.mode === 'firstPerson'} />
        
        {/* Ref Sync - exposes camera, renderer, scene refs to parent component */}
        <RefSync
          cameraRef={cameraRef}
          rendererRef={rendererRef}
          sceneRef={sceneRef}
          controlsRef={controlsRef}
        />
        
        {/* Grid for reference */}
        <gridHelper args={[20, 20, '#444444', '#222222']} />
        
        {/* Scene Capture for Auto-Calibration */}
        <SceneCapture
          triggerCapture={triggerSceneCapture}
          onCapture={(imageData) => handleSceneCaptured(imageData)}
          onCaptureComplete={handleSceneCaptureComplete}
        />
        
        {/* Top-Down Capture for AI Floor Renovation */}
        <TopDownCapture
          meshGroup={meshGroupRef.current}
          trigger={triggerTopDownCapture}
          onCapture={handleTopDownCaptureResult}
          onComplete={handleTopDownCaptureComplete}
        />
        
        {/* Renovation Texture System - applies real materials with calibrated sizing */}
        <RenovationTextureSystem
          meshGroup={meshGroupRef.current}
          calibration={calibration}
          isPreviewMode={showRenovationPreview}
          selectedMaterials={selectedMaterials}
          onCostCalculated={(summary) => {
            // Removed frequent log
            setTextureCostSummary(summary);
          }}
        />
        
        {/* AI Interior Scan Suggestion Markers */}
        {(() => {
          console.log('[PhotogrammetryViewer] Rendering markers check:', aiInteriorScan.suggestions.length);
          return aiInteriorScan.suggestions.length > 0 && (
            <AISuggestionMarkers
              suggestions={aiInteriorScan.suggestions}
              selectedSuggestionId={aiInteriorScan.selectedSuggestion?.id || null}
              onSuggestionSelect={handleAISuggestionClick}
              onGeneratePreview={handleGenerateAIPreview}
              visible={true}
              showLabels={true}
            />
          );
        })()}
      </Canvas>
      
      {/* Material Picker Panel */}
      {showMaterialPicker && (
        <RenovationMaterialPicker
          selectedMaterials={selectedMaterials}
          onSelectionChange={setSelectedMaterials}
          costSummary={textureCostSummary}
          isCalibrated={calibration?.success || false}
          onClose={() => setShowMaterialPicker(false)}
          onGenerateAITexture={handleModifyMeshTexture}
          onAIRenovationPreview={handleAIRenovationPreview}
          onUVRenovation={handleUVRenovation}
          onProRenovation={handleProRenovation}
          onTriplanarRenovation={handleTriplanarRenovation}
          onEnhancedTileRenovation={handleEnhancedTileRenovation}
          isGeneratingAI={isGeneratingAITexture}
          generatingAISurface={generatingAISurface}
          useUVMethod={useUVRenovation}
          onToggleUVMethod={setUseUVRenovation}
          meshSupportsUV={meshSupportsUV}
          renovationMethod={renovationMethod}
          onSetRenovationMethod={setRenovationMethod}
          isRetexturing={isRetexturing}
          retexturingProgress={retexturingProgress}
          // Viewpoint capture props
          capturedViewpoints={capturedViewpoints}
          isCapturingViewpoints={isCapturingViewpoints}
          onStartViewpointCapture={startViewpointCapture}
          onCaptureViewpoint={captureCurrentViewpoint}
          onFinishViewpointCapture={finishViewpointCapture}
          onCancelViewpointCapture={cancelViewpointCapture}
          onRemoveViewpoint={removeViewpoint}
          // Room image capture for Tile method
          capturedRoomImage={capturedRoomImageForTile}
          onCaptureRoomImage={captureRoomImageForTile}
          onClearRoomImage={clearRoomImageForTile}
        />
      )}
      
      {/* Mesh Editor Panel */}
      {showMeshEditor && (
        <div className="absolute top-4 right-4 z-50">
          <MeshEditorPanel
            meshUrl={currentMeshUrl}
            onMeshUpdated={(newUrl) => {
              console.log('[PhotogrammetryViewer] Mesh updated:', newUrl);
              setCurrentMeshUrl(newUrl);
              // The mesh will automatically reload because currentMeshUrl is used in MeshDisplay
            }}
            onClose={() => setShowMeshEditor(false)}
            originalScanId={scanId}
            onStartPlacementMode={(type) => {
              console.log('[PhotogrammetryViewer] Starting placement mode for:', type);
              setOpeningPlacementMode(type);
              setPlacedPosition(null);
              setPlacedNormal(null);
            }}
            placedPosition={placedPosition}
            placedNormal={placedNormal}
            calibration={calibration}
            meshGroup={meshGroupRef.current}
            onStartMeasuredHoleCutter={() => {
              console.log('[PhotogrammetryViewer] Starting measured hole cutter');
              measuredHoleCutter.startCutting();
            }}
            measuredHoleCutter={measuredHoleCutter}
          />
        </div>
      )}
      
      {/* Meshy AI Retexture Panel */}
      {showMeshyRetexture && (
        <div className="absolute top-4 left-4 z-50">
          <MeshyRetexturePanel
            meshUrl={currentMeshUrl}
            onMeshUpdated={(newUrl) => {
              console.log('[PhotogrammetryViewer] Mesh retextured with Meshy:', newUrl);
              setCurrentMeshUrl(newUrl);
              // Trigger reload of the mesh
            }}
            onCaptureViewport={async () => {
              const result = captureViewportForObjectGenerator();
              if (!result) {
                throw new Error('Failed to capture viewport');
              }
              return result;
            }}
            onRequestFloorMeasurement={handleRequestFloorMeasurement}
            floorMeasurement={floorMeasurement}
            onClose={() => setShowMeshyRetexture(false)}
          />
        </div>
      )}
      
      {/* AI Object Generator Panel */}
      {showObjectGenerator && (
        <div className="absolute top-4 right-4 z-50">
          <ObjectGeneratorPanel
            onObjectGenerated={(objectUrl, thumbnailUrl) => {
              console.log('[PhotogrammetryViewer] Object generated:', objectUrl);
              placeObjectInScene(objectUrl);
            }}
            onObjectSelected={(objectUrl) => {
              console.log('[PhotogrammetryViewer] Object selected from library:', objectUrl);
              placeObjectInScene(objectUrl);
            }}
            onClose={() => setShowObjectGenerator(false)}
            onCaptureViewport={captureViewportForObjectGenerator}
          />
        </div>
      )}
      
      {/* Selected Object Controls */}
      {selectedObjectId && (
        <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 z-40 bg-black/90 rounded-xl p-4 backdrop-blur-sm min-w-[400px]">
          <div className="flex flex-col gap-4">
            {/* Header */}
            <div className="flex items-center justify-between">
              <div className="text-white text-sm font-medium flex items-center gap-2">
                📦 <span className="text-blue-400">{placedObjects.find(o => o.id === selectedObjectId)?.name || 'Object'}</span>
              </div>
              <button
                onClick={() => setSelectedObjectId(null)}
                className="text-gray-400 hover:text-white transition-colors"
              >
                ✕
              </button>
            </div>
            
            {/* Transform Mode Selector */}
            <div className="flex gap-1 bg-gray-800 p-1 rounded-lg">
              <button
                onClick={() => setTransformMode('translate')}
                className={`flex-1 py-2 px-3 rounded-md text-xs font-medium transition-colors flex items-center justify-center gap-1.5 ${
                  transformMode === 'translate'
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-400 hover:text-white hover:bg-gray-700'
                }`}
                title="Move object (G)"
              >
                <span>↔️</span> Move
              </button>
              <button
                onClick={() => setTransformMode('rotate')}
                className={`flex-1 py-2 px-3 rounded-md text-xs font-medium transition-colors flex items-center justify-center gap-1.5 ${
                  transformMode === 'rotate'
                    ? 'bg-purple-600 text-white'
                    : 'text-gray-400 hover:text-white hover:bg-gray-700'
                }`}
                title="Rotate object (R)"
              >
                <span>🔄</span> Rotate
              </button>
              <button
                onClick={() => setTransformMode('scale')}
                className={`flex-1 py-2 px-3 rounded-md text-xs font-medium transition-colors flex items-center justify-center gap-1.5 ${
                  transformMode === 'scale'
                    ? 'bg-green-600 text-white'
                    : 'text-gray-400 hover:text-white hover:bg-gray-700'
                }`}
                title="Scale object (S)"
              >
                <span>📐</span> Scale
              </button>
            </div>
            
            {/* Position Nudge Controls */}
            <div className="grid grid-cols-3 gap-2">
              {/* X axis */}
              <div className="flex flex-col items-center gap-1">
                <span className="text-xs text-red-400 font-medium">X</span>
                <div className="flex gap-1">
                  <button
                    onClick={() => nudgeSelectedObject('x', -0.1)}
                    className="px-2 py-1 bg-gray-700 hover:bg-gray-600 text-white rounded text-xs"
                  >
                    ←
                  </button>
                  <button
                    onClick={() => nudgeSelectedObject('x', 0.1)}
                    className="px-2 py-1 bg-gray-700 hover:bg-gray-600 text-white rounded text-xs"
                  >
                    →
                  </button>
                </div>
              </div>
              
              {/* Y axis */}
              <div className="flex flex-col items-center gap-1">
                <span className="text-xs text-green-400 font-medium">Y</span>
                <div className="flex gap-1">
                  <button
                    onClick={() => nudgeSelectedObject('y', -0.1)}
                    className="px-2 py-1 bg-gray-700 hover:bg-gray-600 text-white rounded text-xs"
                  >
                    ↓
                  </button>
                  <button
                    onClick={() => nudgeSelectedObject('y', 0.1)}
                    className="px-2 py-1 bg-gray-700 hover:bg-gray-600 text-white rounded text-xs"
                  >
                    ↑
                  </button>
                </div>
              </div>
              
              {/* Z axis */}
              <div className="flex flex-col items-center gap-1">
                <span className="text-xs text-blue-400 font-medium">Z</span>
                <div className="flex gap-1">
                  <button
                    onClick={() => nudgeSelectedObject('z', -0.1)}
                    className="px-2 py-1 bg-gray-700 hover:bg-gray-600 text-white rounded text-xs"
                  >
                    ←
                  </button>
                  <button
                    onClick={() => nudgeSelectedObject('z', 0.1)}
                    className="px-2 py-1 bg-gray-700 hover:bg-gray-600 text-white rounded text-xs"
                  >
                    →
                  </button>
                </div>
              </div>
            </div>
            
            {/* Quick Rotation */}
            <div className="flex items-center justify-center gap-2">
              <span className="text-xs text-gray-400">Quick Rotate:</span>
              <button
                onClick={() => rotateSelectedObject('y', -45)}
                className="px-2 py-1 bg-gray-700 hover:bg-gray-600 text-white rounded text-xs"
                title="Rotate -45°"
              >
                ↺ 45°
              </button>
              <button
                onClick={() => rotateSelectedObject('y', 45)}
                className="px-2 py-1 bg-gray-700 hover:bg-gray-600 text-white rounded text-xs"
                title="Rotate +45°"
              >
                ↻ 45°
              </button>
              <button
                onClick={() => rotateSelectedObject('y', 90)}
                className="px-2 py-1 bg-gray-700 hover:bg-gray-600 text-white rounded text-xs"
                title="Rotate 90°"
              >
                ↻ 90°
              </button>
            </div>
            
            {/* Actions */}
            <div className="flex gap-2 pt-2 border-t border-gray-700">
              <button
                onClick={() => setSelectedObjectId(null)}
                className="flex-1 px-4 py-2 bg-gray-600 hover:bg-gray-700 text-white rounded-lg font-medium transition-colors text-sm"
              >
                Done
              </button>
              <button
                onClick={removeSelectedObject}
                className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg font-medium transition-colors text-sm"
              >
                🗑️ Delete
              </button>
            </div>
            
            <p className="text-xs text-gray-500 text-center">
              Use gizmo to transform • Arrow keys to nudge • Click elsewhere to deselect
            </p>
          </div>
        </div>
      )}
      
      {/* Placed Objects Count Badge */}
      {placedObjects.length > 0 && !selectedObjectId && (
        <div className="absolute bottom-4 right-4 z-40 bg-black/70 rounded-lg px-3 py-2 text-white text-sm">
          📦 {placedObjects.length} object{placedObjects.length !== 1 ? 's' : ''} placed
        </div>
      )}
      
      {/* Opening Placement Mode Overlay */}
      {openingPlacementMode && (
        <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 z-40 bg-black/80 rounded-lg p-4 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3">
            <div className="text-white text-sm font-medium">
              🎯 Click on a wall to place {openingPlacementMode === 'door' ? 'door' : 'window'} opening
            </div>
            <button
              onClick={() => setOpeningPlacementMode(null)}
              className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg font-medium transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      
      {/* Measured Hole Cutter Mode Overlay */}
      {measuredHoleCutter.isActive && (
        <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 z-40 bg-orange-900/90 rounded-lg p-4 backdrop-blur-sm border border-orange-500">
          <div className="flex flex-col items-center gap-3">
            <div className="text-white text-sm font-medium flex items-center gap-2">
              📐 Measured Hole Cutter Active
            </div>
            <div className="text-orange-200 text-xs text-center max-w-xs">
              {measuredHoleCutter.points.length === 0 
                ? 'Click on a wall to set the first anchor point'
                : measuredHoleCutter.points.length < 3
                ? `${measuredHoleCutter.points.length} point${measuredHoleCutter.points.length > 1 ? 's' : ''} placed. Need ${3 - measuredHoleCutter.points.length} more.`
                : `${measuredHoleCutter.points.length} points placed. Add more or close polygon in the Mesh Editor panel.`
              }
            </div>
            {measuredHoleCutter.previewDistance && (
              <div className="text-yellow-300 text-sm font-mono">
                Distance: {measuredHoleCutter.previewDistance.calibrated.value.toFixed(2)} {measuredHoleCutter.previewDistance.calibrated.unit}
              </div>
            )}
            <div className="flex gap-2">
              <button
                onClick={measuredHoleCutter.undoLastPoint}
                disabled={measuredHoleCutter.points.length === 0}
                className="px-3 py-1 bg-gray-600 hover:bg-gray-700 disabled:bg-gray-800 disabled:text-gray-500 text-white rounded text-sm transition-colors"
              >
                ↩️ Undo
              </button>
              <button
                onClick={measuredHoleCutter.cancel}
                className="px-3 py-1 bg-red-600 hover:bg-red-700 text-white rounded text-sm transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      
      {/* Viewpoint Capture Overlay - shows when capturing viewpoints for Pro renovation */}
      {isCapturingViewpoints && (
        <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 z-40 bg-black/80 rounded-lg p-4 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3">
            <div className="text-white text-sm font-medium">
              📸 Viewpoint Capture Mode ({capturedViewpoints.length} captured)
            </div>
            <div className="flex gap-2">
              <button
                onClick={captureCurrentViewpoint}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors flex items-center gap-2"
              >
                <span>📷</span> Capture View
              </button>
              <button
                onClick={finishViewpointCapture}
                disabled={capturedViewpoints.length < 2}
                className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                  capturedViewpoints.length >= 2 
                    ? 'bg-green-600 hover:bg-green-700 text-white' 
                    : 'bg-gray-600 text-gray-400 cursor-not-allowed'
                }`}
              >
                ✓ Done ({capturedViewpoints.length}/2 min)
              </button>
              <button
                onClick={cancelViewpointCapture}
                className="px-4 py-2 bg-red-600/50 hover:bg-red-600 text-white rounded-lg font-medium transition-colors"
              >
                ✕ Cancel
              </button>
            </div>
            {/* Captured viewpoint thumbnails */}
            {capturedViewpoints.length > 0 && (
              <div className="flex gap-2 mt-2 max-w-lg overflow-x-auto">
                {capturedViewpoints.map((vp, idx) => (
                  <div key={vp.id} className="relative flex-shrink-0">
                    <img 
                      src={vp.imageDataUrl} 
                      alt={`View ${idx + 1}`}
                      className="w-20 h-14 object-cover rounded border border-gray-600"
                    />
                    <button
                      onClick={() => removeViewpoint(vp.id)}
                      className="absolute -top-1 -right-1 w-5 h-5 bg-red-600 rounded-full text-white text-xs flex items-center justify-center hover:bg-red-700"
                    >
                      ✕
                    </button>
                    <div className="absolute bottom-0 left-0 right-0 bg-black/70 text-white text-[10px] text-center">
                      {idx + 1}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      
      {/* AI Renovation Preview Modal */}
      {showRenovationPreviewModal && aiRenovationPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-75">
          <div className="bg-gray-900 rounded-lg p-4 max-w-4xl max-h-[90vh] overflow-auto">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-bold text-white">AI Renovation Preview</h2>
              <button
                onClick={() => {
                  setShowRenovationPreviewModal(false);
                  setAiRenovationPreview(null);
                }}
                className="text-gray-400 hover:text-white text-2xl"
              >
                ×
              </button>
            </div>
            <img 
              src={aiRenovationPreview} 
              alt="AI Renovated Room" 
              className="w-full rounded-lg"
            />
            <p className="text-gray-400 text-sm mt-4 text-center">
              This is an AI-generated preview of how your room could look with the selected renovation.
            </p>
            <div className="flex gap-4 mt-4 justify-center flex-wrap">
              <button
                onClick={handleApplyFloorTo3D}
                disabled={isApplyingTo3D}
                className="px-4 py-2 bg-gradient-to-r from-purple-600 to-pink-600 text-white rounded hover:from-purple-500 hover:to-pink-500 disabled:opacity-50 disabled:cursor-not-allowed font-medium"
              >
                {isApplyingTo3D ? (
                  <span className="flex items-center gap-2">
                    <div className="animate-spin">⚙️</div>
                    Applying...
                  </span>
                ) : (
                  '🎨 Apply to 3D Model'
                )}
              </button>
              <button
                onClick={() => {
                  // Download the image
                  const link = document.createElement('a');
                  link.href = aiRenovationPreview;
                  link.download = 'renovation-preview.jpg';
                  link.click();
                }}
                className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
              >
                Download Image
              </button>
              <button
                onClick={() => {
                  setShowRenovationPreviewModal(false);
                  setAiRenovationPreview(null);
                }}
                className="px-4 py-2 bg-gray-600 text-white rounded hover:bg-gray-700"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
      
      {/* UI Controls */}
      <div className="absolute top-4 left-4 flex flex-col gap-2">
        {/* View Mode Selector */}
        <div className="bg-gray-800 rounded-lg p-2">
          <div className="text-white text-xs mb-1 text-center">View Mode</div>
          <div className="flex flex-col gap-1">
            <button
              onClick={() => setMode('orbit')}
              className={`px-3 py-1.5 rounded font-medium text-sm transition-colors ${
                state.mode === 'orbit'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
              }`}
            >
              🔄 Orbit (Outside)
            </button>
            <button
              onClick={() => setMode('firstPerson')}
              className={`px-3 py-1.5 rounded font-medium text-sm transition-colors ${
                state.mode === 'firstPerson'
                  ? 'bg-purple-600 text-white'
                  : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
              }`}
            >
              👁️ Inside View
            </button>
            {navigation && (
              <button
                onClick={() => setMode('walkthrough')}
                className={`px-3 py-1.5 rounded font-medium text-sm transition-colors ${
                  state.mode === 'walkthrough'
                    ? 'bg-green-600 text-white'
                    : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                }`}
              >
                🚶 Walkthrough
              </button>
            )}
          </div>
        </div>
        
        {/* First Person Instructions */}
        {state.mode === 'firstPerson' && (
          <div className="bg-gray-800/90 rounded-lg p-2 text-xs text-gray-300">
            <div className="font-medium text-white mb-1">Controls:</div>
            <div>• WASD or Arrows to move</div>
            <div>• Click + drag to look</div>
            <div>• Scroll to look around</div>
            <div>• Space up, Shift down</div>
          </div>
        )}
        
        {/* Model Rotation Controls - only in orbit mode */}
        {state.mode === 'orbit' && (
        <div className="bg-gray-800 rounded-lg p-2">
          <div className="text-white text-xs mb-1 text-center">Rotate Model</div>
          <div className="text-gray-400 text-[10px] mb-1 text-center">Shift+Scroll or Shift+Drag</div>
          <div className="flex gap-1">
            <button
              onClick={() => rotateModel('x', 1)}
              className="px-2 py-1 bg-red-600 hover:bg-red-500 text-white rounded text-sm"
              title="Rotate around X axis (flip up/down)"
            >
              ↻ X
            </button>
            <button
              onClick={() => rotateModel('y', 1)}
              className="px-2 py-1 bg-green-600 hover:bg-green-500 text-white rounded text-sm"
              title="Rotate around Y axis (spin)"
            >
              ↻ Y
            </button>
            <button
              onClick={() => rotateModel('z', 1)}
              className="px-2 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded text-sm"
              title="Rotate around Z axis"
            >
              ↻ Z
            </button>
          </div>
        </div>
        )}
        
        {/* Measure toggle */}
        <button
          onClick={toggleMeasureMode}
          className={`px-4 py-2 rounded-lg font-medium transition-colors ${
            state.measuringMode
              ? 'bg-red-600 text-white'
              : 'bg-gray-700 text-white'
          }`}
        >
          📏 {state.measuringMode ? 'Cancel Measure' : 'Measure'}
        </button>
        
        {/* Clear measurements */}
        {state.measurements.length > 0 && (
          <button
            onClick={clearMeasurements}
            className="px-4 py-2 bg-gray-700 text-white rounded-lg font-medium"
          >
            🗑️ Clear
          </button>
        )}
        
        {/* Calibration toggle */}
        <button
          onClick={() => setShowCalibrationPanel(!showCalibrationPanel)}
          className={`px-4 py-2 rounded-lg font-medium transition-colors ${
            calibration?.success
              ? 'bg-green-600 text-white'
              : 'bg-yellow-600 text-white'
          }`}
          title={calibration?.success ? `Calibrated: ${calibration.message}` : 'Not calibrated - click to calibrate'}
        >
          🎯 {calibration?.success ? 'Calibrated' : 'Calibrate'}
        </button>
        
        {/* Renovation Preview toggle - opens material picker and enables preview */}
        <button
          onClick={() => {
            if (!showRenovationPreview) {
              // Opening: show picker and enable preview
              setShowMaterialPicker(true);
              setShowRenovationPreview(true);
            } else {
              // Closing: hide picker and disable preview
              setShowMaterialPicker(false);
              setShowRenovationPreview(false);
            }
          }}
          className={`px-4 py-2 rounded-lg font-medium transition-colors ${
            showRenovationPreview
              ? 'bg-purple-600 text-white'
              : 'bg-indigo-600 text-white hover:bg-indigo-500'
          }`}
          title="Preview renovations with real materials scaled to room measurements"
        >
          🎨 {showRenovationPreview ? 'Close Preview' : 'Preview Renovations'}
        </button>
        
        {/* Toggle material picker when in preview mode */}
        {showRenovationPreview && !showMaterialPicker && (
          <button
            onClick={() => setShowMaterialPicker(true)}
            className="px-4 py-2 rounded-lg font-medium bg-gray-700 text-white hover:bg-gray-600 transition-colors"
            title="Open material selection panel"
          >
            🪵 Materials
          </button>
        )}
        
        {/* Mesh Editor button */}
        <button
          onClick={() => {
            setShowMeshEditor(!showMeshEditor);
            // Set current mesh URL if we have one
            if (meshUrl && !currentMeshUrl) {
              setCurrentMeshUrl(meshUrl);
            }
          }}
          className={`px-4 py-2 rounded-lg font-medium transition-colors ${
            showMeshEditor
              ? 'bg-orange-600 text-white'
              : 'bg-gray-700 text-white hover:bg-gray-600'
          }`}
          title="Edit mesh: remove furniture, cut openings, repair"
        >
          ✏️ Edit Mesh
        </button>
        
        {/* AI Retexture button - Meshy */}
        <button
          onClick={() => {
            setShowMeshyRetexture(!showMeshyRetexture);
            // Set current mesh URL if we have one
            if (meshUrl && !currentMeshUrl) {
              setCurrentMeshUrl(meshUrl);
            }
          }}
          className={`px-4 py-2 rounded-lg font-medium transition-colors ${
            showMeshyRetexture
              ? 'bg-purple-600 text-white'
              : 'bg-gray-700 text-white hover:bg-gray-600'
          }`}
          title="AI Retexture: Apply renovation textures to 3D mesh"
        >
          🎨 AI Retexture
        </button>
        
        {/* AI Object Generator button */}
        <button
          onClick={() => setShowObjectGenerator(!showObjectGenerator)}
          className={`px-4 py-2 rounded-lg font-medium transition-colors ${
            showObjectGenerator
              ? 'bg-indigo-600 text-white'
              : 'bg-gray-700 text-white hover:bg-gray-600'
          }`}
          title="AI Object Generator: Create 3D furniture and objects"
        >
          🪄 Generate Objects
        </button>
        
        {/* AI Interior Scan button */}
        <button
          onClick={handleStartAIInteriorScan}
          disabled={aiInteriorScan.isScanning}
          className={`px-4 py-2 rounded-lg font-medium transition-colors ${
            aiInteriorScan.isScanning
              ? 'bg-purple-500 text-white animate-pulse'
              : aiInteriorScan.suggestions.length > 0
              ? 'bg-green-600 text-white'
              : 'bg-gradient-to-r from-purple-600 to-pink-600 text-white hover:from-purple-500 hover:to-pink-500'
          }`}
          title="AI scans the 3D room from inside and suggests renovations"
        >
          {aiInteriorScan.isScanning ? (
            <span className="flex items-center gap-2">
              <span className="animate-spin">🔍</span>
              Scanning...
            </span>
          ) : aiInteriorScan.suggestions.length > 0 ? (
            `✨ ${aiInteriorScan.suggestions.length} AI Suggestions`
          ) : (
            '🤖 AI Room Scan'
          )}
        </button>
        
        {/* AI Scan Progress Indicator */}
        {aiInteriorScan.scanProgress && (
          <div className="bg-gray-800/90 rounded-lg p-2 text-xs text-white">
            <div className="flex items-center gap-2">
              <div className="animate-spin">⚙️</div>
              <span>{aiInteriorScan.scanProgress.stage}</span>
            </div>
            <div className="mt-1 h-1 bg-gray-700 rounded-full overflow-hidden">
              <div 
                className="h-full bg-gradient-to-r from-purple-500 to-pink-500 transition-all duration-300"
                style={{ width: `${aiInteriorScan.scanProgress.progress * 100}%` }}
              />
            </div>
          </div>
        )}
        
        {/* Clear AI Suggestions button */}
        {aiInteriorScan.suggestions.length > 0 && !aiInteriorScan.isScanning && (
          <button
            onClick={() => aiInteriorScan.clearSuggestions()}
            className="px-4 py-2 rounded-lg font-medium bg-gray-700 text-white hover:bg-gray-600 transition-colors text-sm"
          >
            🗑️ Clear Suggestions
          </button>
        )}
        
        {/* Download GLB button */}
        <button
          onClick={handleDownloadGLB}
          className="px-4 py-2 rounded-lg font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors"
          title="Download this 3D scan as a .glb file"
        >
          📥 Download GLB
        </button>
      </div>
      
      {/* Calibration Panel */}
      {showCalibrationPanel && (
        <div className="absolute top-20 left-4 bg-gray-900/95 text-white p-4 rounded-lg max-w-sm shadow-xl border border-gray-700">
          <div className="flex justify-between items-center mb-3">
            <h3 className="font-bold text-lg">🎯 Measurement Calibration</h3>
            <button 
              onClick={() => setShowCalibrationPanel(false)}
              className="text-gray-400 hover:text-white"
            >
              ✕
            </button>
          </div>
          
          {calibration?.success ? (
            <div className="space-y-3">
              <div className="bg-green-900/50 border border-green-600 rounded p-3">
                <div className="text-green-400 font-medium mb-1">✓ Calibrated</div>
                <div className="text-sm text-gray-300">{calibration.message}</div>
                <div className="text-xs text-gray-400 mt-1">
                  Confidence: {(calibration.confidence * 100).toFixed(0)}%
                </div>
              </div>
              <button
                onClick={() => setCalibration(null)}
                className="w-full px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm"
              >
                Reset Calibration
              </button>
            </div>
          ) : manualCalibrationMode ? (
            <div className="space-y-3">
              <div className="bg-blue-900/50 border border-blue-600 rounded p-3">
                <div className="text-blue-400 font-medium mb-2">Manual Calibration</div>
                <div className="text-sm text-gray-300">
                  {manualCalibrationPoints.length === 0 && 'Click first point on a known object'}
                  {manualCalibrationPoints.length === 1 && 'Click second point'}
                  {manualCalibrationPoints.length === 2 && 'Enter the real-world distance:'}
                </div>
                
                {manualCalibrationPoints.length === 2 && (
                  <div className="mt-3 space-y-2">
                    <div className="flex gap-2">
                      <input
                        type="number"
                        value={manualCalibrationDistance}
                        onChange={(e) => setManualCalibrationDistance(e.target.value)}
                        placeholder="Distance"
                        className="flex-1 px-2 py-1 bg-gray-800 border border-gray-600 rounded text-white"
                      />
                      <span className="text-gray-400 self-center">inches</span>
                    </div>
                    <button
                      onClick={handleConfirmManualCalibration}
                      disabled={!manualCalibrationDistance}
                      className="w-full px-3 py-2 bg-green-600 hover:bg-green-500 disabled:bg-gray-600 disabled:cursor-not-allowed rounded"
                    >
                      Confirm
                    </button>
                  </div>
                )}
              </div>
              <button
                onClick={handleCancelCalibration}
                className="w-full px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm"
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-gray-300">
                Calibrate for accurate real-world measurements. This is essential for renovation cost estimates.
              </p>
              
              {autoCalibrationStatus && (
                <div className={`text-sm px-3 py-2 rounded-lg font-medium border ${
                  autoCalibrationStatus.startsWith('✅') 
                    ? 'text-green-300 bg-green-900/50 border-green-500/50' 
                    : autoCalibrationStatus.startsWith('❌') || autoCalibrationStatus.startsWith('⚠️')
                    ? 'text-red-300 bg-red-900/50 border-red-500/50'
                    : 'text-blue-300 bg-blue-900/50 border-blue-500/50'
                }`}>
                  {autoCalibrationStatus}
                </div>
              )}
              
              {/* Calibration Success Indicator */}
              {calibration?.success && (
                <div className="text-xs text-green-400 bg-green-900/30 px-2 py-1.5 rounded border border-green-500/30">
                  ✓ Calibrated: {calibration.referenceObject?.name} ({(calibration.confidenceScore * 100).toFixed(0)}% confidence)
                  <div className="text-green-500/70 mt-0.5">
                    Scale: 1 mesh unit = {calibration.scaleFactor.toFixed(2)} {calibration.unit}
                  </div>
                </div>
              )}
              
              <button
                onClick={async () => {
                  setIsCalibrating(true);
                  setAutoCalibrationStatus('Capturing scene...');
                  // Trigger scene capture - the SceneCapture component will handle the rest
                  setTriggerSceneCapture(true);
                }}
                disabled={isCalibrating}
                className="w-full px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-600 rounded font-medium"
              >
                {isCalibrating ? 'Analyzing...' : '🤖 Auto-Calibrate (AI)'}
              </button>
              
              <div className="text-xs text-gray-400 bg-gray-800/50 px-2 py-2 rounded border border-gray-700">
                <strong className="text-gray-300">💡 AI looks for:</strong>
                <div className="mt-1 space-y-0.5 ml-2">
                  <div>• Outlets/switches (4.5")</div>
                  <div>• Doors (80" height)</div>
                  <div>• Counters (36" height)</div>
                  <div>• Appliances with visible brands</div>
                </div>
                <div className="mt-1 text-gray-500">Point camera at these objects for best results</div>
              </div>
              
              <button
                onClick={handleStartManualCalibration}
                className="w-full px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded"
              >
                📏 Manual Calibration
              </button>
              
              <div className="text-xs text-gray-500 mt-2">
                <strong>Tip:</strong> For manual calibration, click two points on an object with known dimensions (e.g., door height = 80", outlet cover = 4.5")
              </div>
            </div>
          )}
        </div>
      )}
      
      {/* Measurement instructions */}
      {state.measuringMode && (
        <div className="absolute top-4 right-4 bg-black/70 text-white px-4 py-2 rounded-lg">
          {state.pendingPoints.length === 0
            ? 'Click first point'
            : 'Click second point'}
          {calibration?.success && (
            <div className="text-xs text-green-400 mt-1">✓ Calibrated measurements</div>
          )}
        </div>
      )}
      
      {/* Manual Calibration Mode Indicator */}
      {manualCalibrationMode && (
        <div className="absolute top-4 right-4 bg-blue-900/90 text-white px-4 py-3 rounded-lg border border-blue-500">
          <div className="font-bold mb-1">🎯 Calibration Mode</div>
          <div className="text-sm">
            {manualCalibrationPoints.length === 0 && 'Click first point on known object'}
            {manualCalibrationPoints.length === 1 && 'Click second point'}
            {manualCalibrationPoints.length === 2 && 'Enter distance in calibration panel'}
          </div>
          <div className="text-xs text-blue-300 mt-2">
            Points: {manualCalibrationPoints.length}/2
          </div>
        </div>
      )}
      
      {/* Measurement list */}
      {state.measurements.length > 0 && (
        <div className="absolute bottom-4 left-4 bg-black/70 text-white p-4 rounded-lg max-w-xs">
          <h3 className="font-bold mb-2">Measurements</h3>
          <ul className="space-y-1 text-sm">
            {state.measurements.map((m, i) => (
              <li key={m.id}>
                {i + 1}. {m.value.toFixed(2)} {m.unit}
              </li>
            ))}
          </ul>
        </div>
      )}
      
      {/* Viewpoint info */}
      {state.mode === 'walkthrough' && currentViewpoint && (
        <div className="absolute bottom-4 right-4 bg-black/70 text-white px-4 py-2 rounded-lg">
          <span className="text-sm">Viewpoint: {currentViewpoint.id}</span>
        </div>
      )}
      
      {/* Renovation Detection Status Badge */}
      {renovationDetectionState && (
        <div className="absolute top-4 right-4 bg-gray-900/90 text-white px-4 py-2 rounded-lg">
          {renovationDetectionState.isAnalyzing ? (
            <div className="flex items-center gap-2">
              <div className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full" />
              <span className="text-sm">Analyzing renovations...</span>
            </div>
          ) : renovationDetectionState.renovations.length > 0 ? (
            <div className="text-sm">
              <span className="font-medium text-green-400">
                {renovationDetectionState.renovations.length}
              </span>
              {' '}renovation{renovationDetectionState.renovations.length !== 1 ? 's' : ''} detected
              <span className="text-gray-400 ml-2">
                (click markers to view)
              </span>
            </div>
          ) : renovationDetectionState.error ? (
            <div className="text-red-400 text-sm">
              Analysis failed: {renovationDetectionState.error}
            </div>
          ) : null}
        </div>
      )}
      
      {/* Renovation Details Modal */}
      {showDetailsModal && selectedRenovation && (
        <RenovationDetailsModal
          renovation={selectedRenovation}
          onClose={handleCloseDetailsModal}
          onAddToMarketplace={handleAddToMarketplace}
          onGenerateARPreview={handleARPreview}
        />
      )}
      
      {/* Add to Marketplace Modal */}
      {showMarketplaceModal && selectedRenovation && (
        <AddToMarketplaceModal
          renovation={selectedRenovation}
          scanMetadata={scanMetadata || {
            scanId: scanId,
            address: 'Property Address',
            propertyType: 'residential',
            propertyValue: 350000,
            monthlyRent: 2500,
          }}
          onClose={handleCloseMarketplaceModal}
          onSuccess={handleMarketplaceSuccess}
        />
      )}
      
      {/* AR Renovation Preview */}
      {showARPreview && selectedRenovation && (
        <ARRenovationPreview
          renovation={selectedRenovation}
          meshUrl={meshUrl}
          onClose={handleCloseARPreview}
        />
      )}
      
      {/* Renovation Cost Summary Panel */}
      {showRenovationPreview && textureCostSummary && textureCostSummary.items && textureCostSummary.items.length > 0 && (
        <div className="absolute right-4 top-20 w-80 bg-gray-900/95 rounded-xl shadow-2xl border border-gray-700 max-h-[70vh] overflow-hidden flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between p-4 border-b border-gray-700 bg-gradient-to-r from-purple-600/20 to-indigo-600/20">
            <h3 className="text-lg font-bold text-white flex items-center gap-2">
              ✨ Renovation Preview
            </h3>
            <button 
              onClick={() => setShowRenovationPreview(false)}
              className="text-gray-400 hover:text-white text-xl"
            >
              ×
            </button>
          </div>
          
          {/* ROI Summary */}
          <div className="p-4 bg-green-900/30 border-b border-green-500/30">
            <div className="flex items-center justify-between mb-2">
              <span className="text-green-300 font-medium">Estimated ROI</span>
              <span className="text-green-400 font-bold text-xl">{textureCostSummary.overallROI.toFixed(1)}x</span>
            </div>
            <div className="text-xs text-gray-400">
              Invest ${textureCostSummary.grandTotal.toLocaleString()} → Add ${textureCostSummary.estimatedValueIncrease.toLocaleString()} value
            </div>
          </div>
          
          {/* Renovations List */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            <div className="text-xs text-gray-400 uppercase tracking-wide mb-2">Selected Materials</div>
            {textureCostSummary.items.map((item) => (
              <div 
                key={item.material.id}
                className="p-3 rounded-lg bg-gray-800/50 border border-gray-700"
              >
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <div className="font-medium text-white">{item.material.name}</div>
                    <div className="text-xs text-gray-400 capitalize">{item.material.surfaceType}</div>
                  </div>
                  <span className="text-xs text-green-400 bg-green-900/30 px-2 py-0.5 rounded">
                    {item.roi.toFixed(1)}x ROI
                  </span>
                </div>
                
                <div className="text-sm text-purple-300 mb-2">
                  {item.material.description}
                </div>
                
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="text-gray-400">
                    Area: <span className="text-white">{item.areaSqFt} sq ft</span>
                  </div>
                  <div className="text-gray-400">
                    Materials: <span className="text-white">${item.materialCost.toLocaleString()}</span>
                  </div>
                  <div className="text-gray-400">
                    Labor: <span className="text-white">${item.laborCost.toLocaleString()}</span>
                  </div>
                  <div className="text-gray-400">
                    Total: <span className="text-green-400 font-medium">${item.totalCost.toLocaleString()}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
          
          {/* Totals */}
          <div className="p-4 border-t border-gray-700 bg-gray-800/50">
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-400">Materials</span>
                <span className="text-white">${textureCostSummary.totalMaterialCost.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Labor</span>
                <span className="text-white">${textureCostSummary.totalLaborCost.toLocaleString()}</span>
              </div>
              <div className="flex justify-between pt-2 border-t border-gray-600">
                <span className="text-white font-bold">Total Investment</span>
                <span className="text-green-400 font-bold text-lg">${textureCostSummary.grandTotal.toLocaleString()}</span>
              </div>
            </div>
            
            <button
              onClick={() => {
                // TODO: Add to contractor marketplace
                console.log('[PhotogrammetryViewer] Add to marketplace:', renovationCostSummary);
              }}
              className="w-full mt-4 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-medium transition-colors"
            >
              📋 Get Contractor Quotes
            </button>
          </div>
        </div>
      )}
      
      {/* AI Interior Scan Preview Modal */}
      {aiInteriorScan.selectedSuggestion && (
        <RenovationPreviewModal
          suggestion={aiInteriorScan.selectedSuggestion}
          onClose={handleCloseAIPreview}
          onRegeneratePreview={(suggestion, option) => {
            console.log('[PhotogrammetryViewer] Regenerating preview:', suggestion.title, option);
            handleGenerateAIPreview(suggestion);
          }}
          renovationOptions={getRenovationOptionsForType(aiInteriorScan.selectedSuggestion.type)}
        />
      )}
    </div>
  );
}

// Preload mesh
export function preloadMesh(url: string) {
  useGLTF.preload(url);
}

export default PhotogrammetryViewer;
