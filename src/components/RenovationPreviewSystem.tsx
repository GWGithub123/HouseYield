/**
 * RenovationPreviewSystem Component
 * 
 * Unified system for renovation visualization that:
 * 1. Uses mesh segmentation to identify surfaces
 * 2. Applies materials directly to mesh faces
 * 3. Places fixtures at correct positions
 * 4. Calculates accurate costs based on calibration
 * 5. Optional: Uses Gemini for photorealistic final render
 */

import { useState, useCallback, useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { 
  getMaterialById,
  FLOORING_MATERIALS,
  PAINT_MATERIALS,
  COUNTERTOP_MATERIALS,
} from '../services/materialLibrary';
import { 
  MeshSegmentation, 
  SurfaceSegment,
  segmentMesh,
  applyMaterialToSegment,
  applyAITextureToSegment,
  removeAITexture,
  getSegmentCaptureInfo,
} from '../services/meshSegmentationService';
import type { DetectedRenovation } from '../types/renovationDetection';
import type { CalibrationResult } from '../services/meshCalibrationService';
import {
  generateAITexture,
  loadTextureForThreeJS,
  captureSegmentImage,
  type TextureGenerationRequest,
  type GeneratedTexture,
} from '../services/aiTextureGenerationService';
import {
  performUVRenovation,
  extractMeshTexture,
  generateUVMask,
  type UVRenovationResult,
  type UVRenovationRequest,
} from '../services/uvTextureRenovationService';
import {
  performRenovationRetexturing,
  quickPreviewRenovation,
  generateViewpointsForMesh,
  type EditedView,
  type RetexturingResult,
} from '../services/renovationRetexturingService';
import {
  applySegmentRenovation,
  type TriplanarRenovationResult,
} from '../services/triplanarRenovationService';
import {
  performEnhancedTileRenovation,
  getFloorboardSpecs,
  calculatePlankLayout,
  type EnhancedTileRequest,
} from '../services/enhancedTileRenovationService';

// ============================================================================
// Types
// ============================================================================

interface RenovationSelection {
  renovationId: string;
  segmentId: string;
  materialId?: string;
  fixtureId?: string;
  originalMaterial?: THREE.Material;
}

interface RenovationPreviewSystemProps {
  // The 3D mesh group
  meshGroup: THREE.Group | null;
  
  // Detected renovations from AI analysis
  renovations: DetectedRenovation[];
  
  // Calibration for accurate measurements
  calibration: CalibrationResult | null;
  
  // Callbacks
  onCostUpdate?: (totalCost: number, breakdown: CostBreakdown) => void;
  onPreviewChange?: (activeSelections: RenovationSelection[]) => void;
  onGenerateRender?: (imageData: string) => void;
  
  // UI visibility
  isVisible: boolean;
  onClose: () => void;
}

interface CostBreakdown {
  materials: number;
  labor: number;
  fixtures: number;
  total: number;
  items: CostItem[];
}

interface CostItem {
  name: string;
  category: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  total: number;
}

// ============================================================================
// Main Component
// ============================================================================

export function RenovationPreviewSystem({
  meshGroup,
  renovations,
  calibration,
  onCostUpdate,
  onPreviewChange: _onPreviewChange,
  onGenerateRender,
  isVisible,
  onClose,
}: RenovationPreviewSystemProps) {
  // Mesh segmentation (computed once when mesh loads)
  const [segmentation, setSegmentation] = useState<MeshSegmentation | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  
  // Active renovation selections
  const [selections, setSelections] = useState<RenovationSelection[]>([]);
  
  // Currently editing renovation
  const [activeRenovationId, setActiveRenovationId] = useState<string | null>(null);
  
  // Material picker state
  const [showMaterialPicker, setShowMaterialPicker] = useState(false);
  const [materialCategory, setMaterialCategory] = useState<'flooring' | 'paint' | 'countertop'>('flooring');
  
  // Generate render state
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedImage, setGeneratedImage] = useState<string | null>(null);
  
  // AI texture generation state
  const [isGeneratingAITexture, setIsGeneratingAITexture] = useState(false);
  const [aiTextureMode, setAITextureMode] = useState(false);
  const [appliedAITextures, setAppliedAITextures] = useState<Map<string, GeneratedTexture>>(new Map());
  
  // UV-based renovation state (new approach - edits texture atlas directly)
  const [useUVMethod, setUseUVMethod] = useState(true); // Default to new method
  const [isPerformingUVRenovation, setIsPerformingUVRenovation] = useState(false);
  const [uvRenovationResults, setUVRenovationResults] = useState<Map<string, UVRenovationResult>>(new Map());
  const [originalTexture, setOriginalTexture] = useState<THREE.Texture | null>(null);
  
  // Multi-View Retexturing state (best quality - uses OpenMVS on GCP)
  type RenovationMethod = 'triplanar' | 'uv' | 'multiview' | 'tile';
  const [renovationMethod, setRenovationMethod] = useState<RenovationMethod>('triplanar');
  const [isPerformingRetexturing, setIsPerformingRetexturing] = useState(false);
  const [retexturingProgress, setRetexturingProgress] = useState<{ stage: string; progress: number } | null>(null);
  const [retexturingResult, setRetexturingResult] = useState<RetexturingResult | null>(null);
  const [previewViews, setPreviewViews] = useState<EditedView[]>([]);
  const [showPreviewGallery, setShowPreviewGallery] = useState(false);
  
  // Triplanar renovation state (NEW - recommended approach)
  const [isPerformingTriplanar, setIsPerformingTriplanar] = useState(false);
  const [triplanarResults, setTriplanarResults] = useState<Map<string, TriplanarRenovationResult>>(new Map());
  
  // ============================================================================
  // Analyze mesh on load
  // ============================================================================
  
  useEffect(() => {
    if (meshGroup && !segmentation && !isAnalyzing) {
      setIsAnalyzing(true);
      console.log('[RenovationPreview] Analyzing mesh for surface segmentation...');
      
      // Run segmentation in next frame to not block UI
      requestAnimationFrame(() => {
        try {
          const result = segmentMesh(meshGroup);
          setSegmentation(result);
          console.log('[RenovationPreview] Segmentation complete:', result);
        } catch (error) {
          console.error('[RenovationPreview] Segmentation failed:', error);
        } finally {
          setIsAnalyzing(false);
        }
      });
    }
  }, [meshGroup, segmentation, isAnalyzing]);
  
  // ============================================================================
  // Get scale factor for measurements
  // ============================================================================
  
  const scaleFactor = useMemo(() => {
    if (calibration?.success) {
      return calibration.scaleFactor; // mesh units to inches
    }
    // Default assumption: 1 mesh unit = 1 meter = 39.37 inches
    return 39.37;
  }, [calibration]);
  
  // ============================================================================
  // Map renovations to segments
  // ============================================================================
  
  const renovationSegmentMap = useMemo(() => {
    if (!segmentation) return new Map<string, SurfaceSegment>();
    
    const map = new Map<string, SurfaceSegment>();
    
    for (const renovation of renovations) {
      // Match renovation to appropriate segment based on zone type
      let matchedSegment: SurfaceSegment | null = null;
      const renovationType = renovation.zone.type;
      
      switch (renovationType) {
        case 'flooring':
          matchedSegment = segmentation.floors[0] || null;
          break;
        case 'paint':
        case 'walls':
          matchedSegment = segmentation.walls[0] || null;
          break;
        case 'countertops':
          matchedSegment = segmentation.counters[0] || null;
          break;
        case 'bathroom':
        case 'plumbing':
          // For bathroom/plumbing, find any fixture segment (sink, toilet, etc.)
          matchedSegment = segmentation.fixtures[0] || null;
          break;
      }
      
      if (matchedSegment) {
        map.set(renovation.id, matchedSegment);
      }
    }
    
    return map;
  }, [renovations, segmentation]);
  
  // ============================================================================
  // Calculate real-world area
  // ============================================================================
  
  const getSegmentArea = useCallback((segment: SurfaceSegment): number => {
    // Convert mesh area to square feet
    const areaInMeshUnits = segment.area;
    const areaInSquareInches = areaInMeshUnits * scaleFactor * scaleFactor;
    const areaInSquareFeet = areaInSquareInches / 144;
    return areaInSquareFeet;
  }, [scaleFactor]);
  
  // ============================================================================
  // Apply material to renovation
  // ============================================================================
  
  const applyMaterial = useCallback((renovationId: string, materialId: string) => {
    const segment = renovationSegmentMap.get(renovationId);
    const material = getMaterialById(materialId);
    
    if (!segment || !material || !meshGroup) {
      console.error('[RenovationPreview] Cannot apply material:', { segment, material });
      return;
    }
    
    console.log('[RenovationPreview] Applying material:', material.name, 'to segment:', segment.id);
    
    // Find the mesh containing this segment
    meshGroup.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        applyMaterialToSegment(child, segment, {
          id: material.id,
          name: material.name,
          type: material.color ? 'color' : 'texture',
          textureUrl: material.textureUrl,
          color: material.color,
          roughness: material.roughness,
          metalness: material.metalness,
          textureRealWorldSize: material.textureRealSize,
        }, scaleFactor);
      }
    });
    
    // Update selections
    setSelections(prev => {
      const existing = prev.find(s => s.renovationId === renovationId);
      if (existing) {
        return prev.map(s => 
          s.renovationId === renovationId 
            ? { ...s, materialId } 
            : s
        );
      }
      return [...prev, { renovationId, segmentId: segment.id, materialId }];
    });
    
    setShowMaterialPicker(false);
  }, [renovationSegmentMap, meshGroup, scaleFactor]);
  
  // ============================================================================
  // Generate and Apply AI Texture
  // ============================================================================
  
  const generateAndApplyAITexture = useCallback(async (
    renovationId: string,
    renderer?: THREE.WebGLRenderer,
    camera?: THREE.Camera,
    scene?: THREE.Scene
  ) => {
    const segment = renovationSegmentMap.get(renovationId);
    const renovation = renovations.find(r => r.id === renovationId);
    
    if (!segment || !renovation || !meshGroup || !calibration) {
      console.error('[RenovationPreview] Cannot generate AI texture: missing data');
      return;
    }
    
    setIsGeneratingAITexture(true);
    
    try {
      console.log('[RenovationPreview] Generating AI texture for:', renovation.title);
      
      // Get segment info with real-world dimensions
      const captureInfo = getSegmentCaptureInfo(segment, scaleFactor);
      
      // Capture segment image (placeholder for now)
      const segmentImage = 'data:image/jpeg;base64,';
      
      // Determine renovation type and option from AI analysis
      const renovationType = renovation.category === 'flooring' ? 'flooring' : 
                           renovation.category === 'paint' ? 'paint' :
                           renovation.category === 'countertops' ? 'countertop' : 'flooring';
      
      const renovationOption = renovation.title.toLowerCase().includes('hardwood') ? 'hardwood' :
                             renovation.title.toLowerCase().includes('tile') ? 'tile' :
                             renovation.title.toLowerCase().includes('marble') ? 'marble' :
                             renovation.title.toLowerCase().includes('white') ? 'white' :
                             renovation.title.toLowerCase().includes('gray') ? 'gray' :
                             'hardwood'; // default
      
      // Generate AI texture
      const textureRequest: TextureGenerationRequest = {
        segmentImage,
        segmentType: captureInfo.segmentType,
        renovationType,
        renovationOption,
        dimensions: captureInfo.realWorldDimensions,
      };
      
      const generatedTexture = await generateAITexture(textureRequest);
      
      console.log('[RenovationPreview] AI texture generated:', generatedTexture);
      
      // Load texture into THREE.js
      const threeTexture = await loadTextureForThreeJS(generatedTexture);
      
      // Apply to mesh segment
      meshGroup.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          applyAITextureToSegment(
            child,
            segment,
            threeTexture,
            generatedTexture.realWorldScale,
            scaleFactor
          );
        }
      });
      
      // Store applied texture
      setAppliedAITextures(prev => new Map(prev).set(renovationId, generatedTexture));
      
      // Update selections
      setSelections(prev => {
        const existing = prev.find(s => s.renovationId === renovationId);
        if (existing) {
          return prev.map(s => 
            s.renovationId === renovationId 
              ? { ...s, materialId: 'ai-generated' } 
              : s
          );
        }
        return [...prev, { renovationId, segmentId: segment.id, materialId: 'ai-generated' }];
      });
      
      console.log('[RenovationPreview] ✅ AI texture applied to 3D mesh');
      
    } catch (error) {
      console.error('[RenovationPreview] AI texture generation failed:', error);
      alert('Failed to generate AI texture. Please try again.');
    } finally {
      setIsGeneratingAITexture(false);
    }
  }, [renovationSegmentMap, renovations, meshGroup, calibration, scaleFactor]);
  
  // ============================================================================
  // NEW: UV-Based Renovation (edits texture atlas directly)
  // This preserves lighting, shadows, and works from all viewing angles
  // ============================================================================
  
  const performUVBasedRenovation = useCallback(async (
    renovationId: string,
    customMaterial?: string
  ) => {
    const segment = renovationSegmentMap.get(renovationId);
    const renovation = renovations.find(r => r.id === renovationId);
    
    if (!segment || !renovation || !meshGroup || !segmentation) {
      console.error('[RenovationPreview] Cannot perform UV renovation: missing data');
      alert('Cannot perform UV renovation: mesh not fully analyzed');
      return;
    }
    
    // Find the actual mesh in the group
    let targetMesh: THREE.Mesh | null = null;
    meshGroup.traverse((child) => {
      if (child instanceof THREE.Mesh && child.geometry && !targetMesh) {
        targetMesh = child;
      }
    });
    
    if (!targetMesh) {
      console.error('[RenovationPreview] No mesh found in group');
      return;
    }
    
    setIsPerformingUVRenovation(true);
    setActiveRenovationId(renovationId);
    
    try {
      console.log('[RenovationPreview] 🎨 Starting UV-based renovation...');
      console.log('[RenovationPreview] Renovation:', renovation.title);
      
      // Determine surface type and material
      const targetSurface = renovation.zone.type === 'flooring' ? 'floor' :
                           renovation.zone.type === 'paint' || renovation.zone.type === 'walls' ? 'wall' :
                           renovation.zone.type === 'countertops' ? 'counter' : 'floor';
      
      const renovationType = renovation.category === 'flooring' ? 'flooring' : 
                            renovation.category === 'paint' ? 'paint' :
                            renovation.category === 'countertops' ? 'countertop' : 'flooring';
      
      // Determine material option from renovation title or custom input
      let renovationOption = customMaterial || 'hardwood';
      if (!customMaterial) {
        const title = renovation.title.toLowerCase();
        if (title.includes('hardwood') || title.includes('oak')) renovationOption = 'hardwood';
        else if (title.includes('walnut')) renovationOption = 'walnut';
        else if (title.includes('tile')) renovationOption = 'tile';
        else if (title.includes('marble')) renovationOption = 'marble';
        else if (title.includes('vinyl')) renovationOption = 'vinyl';
        else if (title.includes('carpet')) renovationOption = 'carpet';
        else if (title.includes('white')) renovationOption = 'white';
        else if (title.includes('gray')) renovationOption = 'gray';
        else if (title.includes('beige')) renovationOption = 'beige';
        else if (title.includes('navy')) renovationOption = 'navy';
      }
      
      console.log('[RenovationPreview] UV Renovation params:', {
        targetSurface,
        renovationType,
        renovationOption,
      });
      
      // Store original texture before first modification
      if (!originalTexture) {
        const extraction = extractMeshTexture(targetMesh);
        if (extraction) {
          setOriginalTexture(extraction.originalTexture.clone());
        }
      }
      
      // Perform the UV-based renovation
      const request: UVRenovationRequest = {
        mesh: targetMesh,
        segmentation,
        targetSurface: targetSurface as 'floor' | 'wall' | 'ceiling' | 'counter',
        renovationType,
        renovationOption,
      };
      
      const result = await performUVRenovation(request);
      
      if (result.success) {
        console.log('[RenovationPreview] ✅ UV renovation applied successfully!');
        
        // Store result
        setUVRenovationResults(prev => new Map(prev).set(renovationId, result));
        
        // Update selections
        setSelections(prev => {
          const existing = prev.find(s => s.renovationId === renovationId);
          if (existing) {
            return prev.map(s => 
              s.renovationId === renovationId 
                ? { ...s, materialId: `uv-${renovationOption}` } 
                : s
            );
          }
          return [...prev, { renovationId, segmentId: segment.id, materialId: `uv-${renovationOption}` }];
        });
      }
      
    } catch (error: any) {
      console.error('[RenovationPreview] UV renovation failed:', error);
      alert(`UV renovation failed: ${error.message}. Try the legacy AI texture method.`);
    } finally {
      setIsPerformingUVRenovation(false);
      setActiveRenovationId(null);
    }
  }, [renovationSegmentMap, renovations, meshGroup, segmentation, originalTexture]);
  
  // ============================================================================
  // Triplanar Renovation (NEW - Recommended Approach)
  // Uses world-space texture projection for consistent appearance from all angles
  // ============================================================================
  
  const performTriplanarRenovation = useCallback(async (
    renovationId: string,
    customMaterial?: string
  ) => {
    const segment = renovationSegmentMap.get(renovationId);
    const renovation = renovations.find(r => r.id === renovationId);
    
    if (!segment || !renovation || !meshGroup || !calibration) {
      console.error('[RenovationPreview] Cannot perform triplanar renovation: missing data');
      alert('Cannot perform triplanar renovation: mesh not fully analyzed or calibrated');
      return;
    }
    
    // Find the actual mesh in the group
    let targetMesh: THREE.Mesh | null = null;
    meshGroup.traverse((child) => {
      if (child instanceof THREE.Mesh && child.geometry && !targetMesh) {
        targetMesh = child;
      }
    });
    
    if (!targetMesh) {
      console.error('[RenovationPreview] No mesh found in group');
      return;
    }
    
    setIsPerformingTriplanar(true);
    setActiveRenovationId(renovationId);
    setRetexturingProgress({ stage: 'Starting triplanar renovation...', progress: 0 });
    
    try {
      console.log('[RenovationPreview] 🎨 Starting triplanar renovation...');
      
      // Determine renovation parameters
      const renovationType = renovation.category === 'flooring' ? 'flooring' : 
                            renovation.category === 'paint' ? 'paint' :
                            renovation.category === 'countertops' ? 'countertop' : 'flooring';
      
      // Get material option (default or custom)
      const renovationOption = customMaterial || renovation.suggestions?.[0]?.material || 
                               (renovationType === 'flooring' ? 'hardwood' : 'white');
      
      console.log('[RenovationPreview] Renovation type:', renovationType, '- Option:', renovationOption);
      
      // Get world scale from calibration
      const worldScale = calibration.scaleFactor || 1.0;
      
      // Perform triplanar renovation
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
        console.log('[RenovationPreview] ✅ Triplanar renovation applied successfully!');
        
        // Store result for restoration
        setTriplanarResults(prev => new Map(prev).set(renovationId, result));
        
        // Update selections
        setSelections(prev => {
          const existing = prev.find(s => s.renovationId === renovationId);
          if (existing) {
            return prev.map(s => 
              s.renovationId === renovationId 
                ? { ...s, materialId: `triplanar-${renovationOption}` } 
                : s
            );
          }
          return [...prev, { renovationId, segmentId: segment.id, materialId: `triplanar-${renovationOption}` }];
        });
        
        setRetexturingProgress({ stage: 'Complete!', progress: 1 });
      } else {
        throw new Error(result.error || 'Triplanar renovation failed');
      }
      
    } catch (error: any) {
      console.error('[RenovationPreview] Triplanar renovation failed:', error);
      alert(`Triplanar renovation failed: ${error.message}`);
    } finally {
      setIsPerformingTriplanar(false);
      setActiveRenovationId(null);
      setTimeout(() => setRetexturingProgress(null), 2000);
    }
  }, [renovationSegmentMap, renovations, meshGroup, calibration]);
  
  // ============================================================================
  // Enhanced Tile Renovation (NEW - Contextual Floor Generation)
  // Uses top-down room image for realistic floor generation with proper plank sizing
  // ============================================================================
  
  const performEnhancedTileRenovationHandler = useCallback(async (
    renovationId: string,
    customMaterial?: string,
    renderer?: THREE.WebGLRenderer,
    camera?: THREE.PerspectiveCamera | THREE.OrthographicCamera,
    controls?: any,
    scene?: THREE.Scene
  ) => {
    const segment = renovationSegmentMap.get(renovationId);
    const renovation = renovations.find(r => r.id === renovationId);
    
    if (!segment || !renovation || !meshGroup || !calibration) {
      console.error('[RenovationPreview] Cannot perform enhanced tile renovation: missing data');
      alert('Cannot perform enhanced tile renovation: mesh not fully analyzed or calibrated');
      return;
    }
    
    // Check if we have the necessary Three.js context
    if (!renderer || !camera || !controls || !scene) {
      console.warn('[RenovationPreview] Missing Three.js context for enhanced tile, falling back to triplanar');
      return performTriplanarRenovation(renovationId, customMaterial);
    }
    
    setIsPerformingTriplanar(true); // Reuse triplanar loading state
    setActiveRenovationId(renovationId);
    setRetexturingProgress({ stage: 'Capturing room view...', progress: 0 });
    
    try {
      console.log('[RenovationPreview] 🔄 Starting enhanced tile renovation...');
      
      // Determine material option
      const materialOption = customMaterial || renovation.suggestions?.[0]?.material || 
        (renovation.title.toLowerCase().includes('walnut') ? 'walnut' :
         renovation.title.toLowerCase().includes('oak') ? 'oak' :
         renovation.title.toLowerCase().includes('vinyl') ? 'vinyl' :
         renovation.title.toLowerCase().includes('tile') ? 'tile' : 'hardwood');
      
      console.log('[RenovationPreview] Enhanced tile - Material option:', materialOption);
      
      // Get room dimensions from calibration
      const roomWidth = calibration.roomDimensions?.width || 10;
      const roomLength = calibration.roomDimensions?.length || 12;
      const unit = calibration.roomDimensions?.unit || 'ft';
      
      // Convert to meters if needed
      const widthMeters = unit === 'ft' ? roomWidth * 0.3048 : roomWidth / 100;
      const lengthMeters = unit === 'ft' ? roomLength * 0.3048 : roomLength / 100;
      
      // Get floorboard specs for this material
      const floorboardSpecs = getFloorboardSpecs(materialOption);
      
      console.log('[RenovationPreview] Room dimensions:', widthMeters.toFixed(2), 'x', lengthMeters.toFixed(2), 'm');
      console.log('[RenovationPreview] Floorboard specs:', floorboardSpecs);
      
      // Perform enhanced tile renovation
      const result = await performEnhancedTileRenovation(
        {
          renderer,
          scene,
          meshGroup,
          camera,
          controls,
          segment,
          materialType: 'flooring',
          materialOption,
          roomDimensions: {
            widthMeters,
            lengthMeters,
          },
          floorboardSpecs,
          worldScale: calibration.scaleFactor || 1.0,
        },
        (stage, progress) => {
          setRetexturingProgress({ stage, progress });
        }
      );
      
      if (result.success) {
        console.log('[RenovationPreview] ✅ Enhanced tile renovation applied successfully!');
        
        // Update selections
        setSelections(prev => {
          const existing = prev.find(s => s.renovationId === renovationId);
          if (existing) {
            return prev.map(s => 
              s.renovationId === renovationId 
                ? { ...s, materialId: `enhanced-tile-${materialOption}` } 
                : s
            );
          }
          return [...prev, { renovationId, segmentId: segment.id, materialId: `enhanced-tile-${materialOption}` }];
        });
        
        setRetexturingProgress({ stage: 'Complete!', progress: 1 });
      } else {
        throw new Error(result.error || 'Enhanced tile renovation failed');
      }
      
    } catch (error: any) {
      console.error('[RenovationPreview] Enhanced tile renovation failed:', error);
      // Fallback to triplanar
      console.log('[RenovationPreview] Falling back to triplanar renovation...');
      return performTriplanarRenovation(renovationId, customMaterial);
    } finally {
      setIsPerformingTriplanar(false);
      setActiveRenovationId(null);
      setTimeout(() => setRetexturingProgress(null), 2000);
    }
  }, [renovationSegmentMap, renovations, meshGroup, calibration, performTriplanarRenovation]);
  
  // ============================================================================
  // Multi-View Retexturing (Best Quality - Uses OpenMVS)
  // ============================================================================
  
  const performMultiViewRetexturing = useCallback(async (
    renovationId: string,
    customMaterial?: string,
    quickPreview: boolean = false
  ) => {
    const renovation = renovations.find(r => r.id === renovationId);
    
    if (!renovation || !meshGroup) {
      console.error('[RenovationPreview] Cannot perform retexturing: missing data');
      alert('Cannot perform retexturing: mesh not loaded');
      return;
    }
    
    // Find the actual mesh in the group
    let targetMesh: THREE.Mesh | null = null;
    meshGroup.traverse((child) => {
      if (child instanceof THREE.Mesh && child.geometry && !targetMesh) {
        targetMesh = child;
      }
    });
    
    if (!targetMesh) {
      console.error('[RenovationPreview] No mesh found in group');
      return;
    }
    
    setIsPerformingRetexturing(true);
    setActiveRenovationId(renovationId);
    setRetexturingProgress({ stage: 'Starting...', progress: 0 });
    
    try {
      console.log('[RenovationPreview] 🚀 Starting multi-view retexturing...');
      
      // Determine renovation parameters
      const renovationType = renovation.category === 'flooring' ? 'flooring' : 
                            renovation.category === 'paint' ? 'paint' :
                            renovation.category === 'countertops' ? 'countertop' : 'flooring';
      
      let renovationOption = customMaterial || 'hardwood';
      if (!customMaterial) {
        const title = renovation.title.toLowerCase();
        if (title.includes('hardwood') || title.includes('oak')) renovationOption = 'hardwood';
        else if (title.includes('walnut')) renovationOption = 'walnut';
        else if (title.includes('tile')) renovationOption = 'tile';
        else if (title.includes('marble')) renovationOption = 'marble';
        else if (title.includes('vinyl')) renovationOption = 'vinyl';
        else if (title.includes('carpet')) renovationOption = 'carpet';
      }
      
      // Get room dimensions from calibration
      const roomDimensions = calibration?.roomDimensions ? {
        width: calibration.roomDimensions.width,
        length: calibration.roomDimensions.length,
        height: calibration.roomDimensions.height || 8,
        unit: 'ft' as const,
      } : undefined;
      
      // Get the scene from the mesh's parent
      let scene: THREE.Scene | null = null;
      let current: THREE.Object3D | null = meshGroup;
      while (current) {
        if (current instanceof THREE.Scene) {
          scene = current;
          break;
        }
        current = current.parent;
      }
      
      if (!scene) {
        // Create a temporary scene
        scene = new THREE.Scene();
        scene.add(meshGroup.clone());
      }
      
      if (quickPreview) {
        // Quick preview mode - just get Gemini-edited views
        setRetexturingProgress({ stage: 'Generating preview views...', progress: 0.2 });
        
        const views = await quickPreviewRenovation(
          targetMesh,
          scene,
          renovationType,
          renovationOption,
          roomDimensions,
          4 // Only 4 views for quick preview
        );
        
        setPreviewViews(views);
        setShowPreviewGallery(true);
        setRetexturingProgress({ stage: 'Preview ready!', progress: 1 });
        
      } else {
        // Full retexturing pipeline with OpenMVS
        const viewpoints = generateViewpointsForMesh(targetMesh, 12);
        
        const result = await performRenovationRetexturing(
          {
            mesh: targetMesh,
            scene,
            viewpoints,
            renovationType,
            renovationOption,
            roomDimensions,
          },
          (stage, progress) => {
            setRetexturingProgress({ stage, progress });
          }
        );
        
        if (result.success) {
          console.log('[RenovationPreview] ✅ Multi-view retexturing complete!');
          setRetexturingResult(result);
          setPreviewViews(result.editedViews);
          
          // Update selections
          setSelections(prev => {
            const segment = renovationSegmentMap.get(renovationId);
            if (!segment) return prev;
            
            const existing = prev.find(s => s.renovationId === renovationId);
            if (existing) {
              return prev.map(s => 
                s.renovationId === renovationId 
                  ? { ...s, materialId: `retex-${renovationOption}` } 
                  : s
              );
            }
            return [...prev, { renovationId, segmentId: segment.id, materialId: `retex-${renovationOption}` }];
          });
        }
      }
      
    } catch (error: any) {
      console.error('[RenovationPreview] Multi-view retexturing failed:', error);
      alert(`Retexturing failed: ${error.message}`);
    } finally {
      setIsPerformingRetexturing(false);
      setActiveRenovationId(null);
      setRetexturingProgress(null);
    }
  }, [renovations, meshGroup, calibration, renovationSegmentMap]);
  
  // ============================================================================
  // Calculate costs
  // ============================================================================
  
  const costBreakdown = useMemo((): CostBreakdown => {
    const items: CostItem[] = [];
    let materials = 0;
    let labor = 0;
    let fixtures = 0;
    
    for (const selection of selections) {
      const segment = renovationSegmentMap.get(selection.renovationId);
      if (!segment) continue;
      
      if (selection.materialId) {
        const material = getMaterialById(selection.materialId);
        if (material) {
          const area = getSegmentArea(segment);
          const materialCost = area * material.pricePerSqFt;
          const laborCost = area * material.laborPerSqFt;
          
          items.push({
            name: material.name,
            category: material.category,
            quantity: Math.round(area),
            unit: 'sq ft',
            unitPrice: material.pricePerSqFt + material.laborPerSqFt,
            total: materialCost + laborCost,
          });
          
          materials += materialCost;
          labor += laborCost;
        }
      }
      
      if (selection.fixtureId) {
        // TODO: Add fixture costs
      }
    }
    
    const total = materials + labor + fixtures;
    
    return { materials, labor, fixtures, total, items };
  }, [selections, renovationSegmentMap, getSegmentArea]);
  
  // Notify parent of cost changes
  useEffect(() => {
    onCostUpdate?.(costBreakdown.total, costBreakdown);
  }, [costBreakdown, onCostUpdate]);
  
  // ============================================================================
  // Generate photorealistic render with Gemini
  // ============================================================================
  
  const handleGenerateRender = useCallback(async (renderer: THREE.WebGLRenderer, camera: THREE.Camera, scene: THREE.Scene) => {
    setIsGenerating(true);
    
    try {
      // Capture current scene
      renderer.render(scene, camera);
      const imageData = renderer.domElement.toDataURL('image/jpeg', 0.9);
      
      // Build description of changes
      const changesDescription = selections.map(s => {
        const material = s.materialId ? getMaterialById(s.materialId) : null;
        const renovation = renovations.find(r => r.id === s.renovationId);
        if (material && renovation) {
          return `${renovation.zone.type}: ${material.name}`;
        }
        return null;
      }).filter(Boolean).join(', ');
      
      // Send to Gemini for enhancement
      const response = await fetch('/api/renovation-preview/generate-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageData,
          customPrompt: `Enhance this room visualization to be photorealistic. The following renovations have been applied: ${changesDescription}. Make the materials look realistic with proper lighting, reflections, and shadows.`,
        }),
      });
      
      const result = await response.json();
      
      if (result.success && result.generatedImageUrl) {
        setGeneratedImage(result.generatedImageUrl);
        onGenerateRender?.(result.generatedImageUrl);
      } else {
        console.log('[RenovationPreview] Gemini response:', result.description);
      }
    } catch (error) {
      console.error('[RenovationPreview] Render generation failed:', error);
    } finally {
      setIsGenerating(false);
    }
  }, [selections, renovations, onGenerateRender]);
  
  // Note: handleGenerateRender is available for external Three.js context usage
  // It will be called once we pass renderer/camera/scene from parent component
  void handleGenerateRender; // Suppress unused warning until integration is complete
  
  // ============================================================================
  // Reset all changes
  // ============================================================================
  
  const resetAll = useCallback(() => {
    // Restore original texture if we have it
    if (originalTexture && meshGroup) {
      meshGroup.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          const materials = Array.isArray(child.material) ? child.material : [child.material];
          for (const mat of materials) {
            if (mat instanceof THREE.MeshStandardMaterial || 
                mat instanceof THREE.MeshBasicMaterial ||
                mat instanceof THREE.MeshPhongMaterial) {
              mat.map = originalTexture;
              mat.needsUpdate = true;
            }
          }
        }
      });
      console.log('[RenovationPreview] Restored original texture');
    }
    
    setSelections([]);
    setGeneratedImage(null);
    setUVRenovationResults(new Map());
    setAppliedAITextures(new Map());
  }, [originalTexture, meshGroup]);
  
  // ============================================================================
  // Render
  // ============================================================================
  
  if (!isVisible) return null;
  
  return (
    <div className="absolute right-4 top-20 w-96 bg-gray-900/95 rounded-xl shadow-2xl border border-gray-700 max-h-[80vh] overflow-hidden flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-gray-700">
        <h3 className="text-lg font-bold text-white flex items-center gap-2">
          🎨 Renovation Preview
        </h3>
        <button 
          onClick={onClose}
          className="text-gray-400 hover:text-white text-xl"
        >
          ×
        </button>
      </div>
      
      {/* Analysis Status */}
      {isAnalyzing && (
        <div className="p-4 bg-blue-900/30 border-b border-blue-500/30">
          <div className="flex items-center gap-2 text-blue-300">
            <div className="animate-spin">⚙️</div>
            Analyzing mesh surfaces...
          </div>
        </div>
      )}
      
      {/* Method Toggle */}
      <div className="p-3 bg-gray-800/50 border-b border-gray-700">
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-400">AI Method:</span>
          <div className="flex bg-gray-700 rounded-lg p-0.5">
            <button
              onClick={() => setRenovationMethod('triplanar')}
              className={`px-2 py-1 text-xs rounded-md transition-colors ${
                renovationMethod === 'triplanar'
                  ? 'bg-gradient-to-r from-orange-500 to-amber-500 text-white' 
                  : 'text-gray-400 hover:text-white'
              }`}
              title="Recommended - Real-time triplanar projection, works from all angles"
            >
              ⚡ Fast
            </button>
            <button
              onClick={() => setRenovationMethod('multiview')}
              className={`px-2 py-1 text-xs rounded-md transition-colors ${
                renovationMethod === 'multiview'
                  ? 'bg-gradient-to-r from-green-600 to-emerald-600 text-white' 
                  : 'text-gray-400 hover:text-white'
              }`}
              title="OpenMVS on GCP - may have artifacts"
            >
              🚀 Pro
            </button>
            <button
              onClick={() => setRenovationMethod('uv')}
              className={`px-2 py-1 text-xs rounded-md transition-colors ${
                renovationMethod === 'uv'
                  ? 'bg-purple-600 text-white' 
                  : 'text-gray-400 hover:text-white'
              }`}
              title="Fast - Edits texture atlas directly"
            >
              🎨 UV
            </button>
            <button
              onClick={() => setRenovationMethod('tile')}
              className={`px-2 py-1 text-xs rounded-md transition-colors ${
                renovationMethod === 'tile'
                  ? 'bg-blue-600 text-white' 
                  : 'text-gray-400 hover:text-white'
              }`}
              title="Contextual AI - Uses room image for realistic floor generation"
            >
              🔄 Tile
            </button>
          </div>
        </div>
        <p className="text-xs text-gray-500 mt-1">
          {renovationMethod === 'triplanar' 
            ? '⚡ Fast: Triplanar projection - real-time, correct from all angles (recommended)' 
            : renovationMethod === 'multiview' 
            ? '🚀 Pro: Multi-view Gemini + OpenMVS (may have artifacts)' 
            : renovationMethod === 'uv'
            ? '✨ UV: Fast texture atlas editing (preserves lighting)' 
            : '🔄 Tile: Contextual floor generation - uses room image for realistic planks'}
        </p>
        
        {/* Progress indicator for retexturing */}
        {retexturingProgress && (
          <div className="mt-2">
            <div className="flex items-center justify-between text-xs text-gray-400 mb-1">
              <span>{retexturingProgress.stage}</span>
              <span>{Math.round(retexturingProgress.progress * 100)}%</span>
            </div>
            <div className="w-full bg-gray-700 rounded-full h-1.5">
              <div 
                className="bg-gradient-to-r from-green-500 to-emerald-500 h-1.5 rounded-full transition-all duration-300"
                style={{ width: `${retexturingProgress.progress * 100}%` }}
              />
            </div>
          </div>
        )}
      </div>
      
      {/* Segmentation Summary */}
      {segmentation && (
        <div className="p-3 bg-gray-800/50 border-b border-gray-700 text-xs">
          <div className="text-gray-400 mb-1">Detected Surfaces:</div>
          <div className="flex gap-2 flex-wrap">
            {segmentation.floors.length > 0 && (
              <span className="px-2 py-0.5 bg-amber-900/50 text-amber-300 rounded">
                Floor ({Math.round(getSegmentArea(segmentation.floors[0]))} sq ft)
              </span>
            )}
            {segmentation.walls.length > 0 && (
              <span className="px-2 py-0.5 bg-blue-900/50 text-blue-300 rounded">
                Walls ({segmentation.walls.length})
              </span>
            )}
            {segmentation.counters.length > 0 && (
              <span className="px-2 py-0.5 bg-purple-900/50 text-purple-300 rounded">
                Counter
              </span>
            )}
            {segmentation.fixtures.length > 0 && (
              <span className="px-2 py-0.5 bg-green-900/50 text-green-300 rounded">
                Fixtures ({segmentation.fixtures.length})
              </span>
            )}
          </div>
        </div>
      )}
      
      {/* Renovation List */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {renovations.map((renovation) => {
          const segment = renovationSegmentMap.get(renovation.id);
          const selection = selections.find(s => s.renovationId === renovation.id);
          const selectedMaterial = selection?.materialId ? getMaterialById(selection.materialId) : null;
          
          return (
            <div 
              key={renovation.id}
              className={`p-3 rounded-lg border transition-colors ${
                activeRenovationId === renovation.id
                  ? 'bg-blue-900/30 border-blue-500'
                  : 'bg-gray-800/50 border-gray-700 hover:border-gray-600'
              }`}
            >
              <div className="flex items-start justify-between mb-2">
                <div>
                  <div className="font-medium text-white">{renovation.zone.name}</div>
                  <div className="text-xs text-gray-400 capitalize">{renovation.zone.type}</div>
                </div>
                {segment && (
                  <span className="text-xs text-green-400 bg-green-900/30 px-2 py-0.5 rounded">
                    Mapped
                  </span>
                )}
              </div>
              
              {/* Current Selection */}
              {selectedMaterial && (
                <div className="mb-2 p-2 bg-gray-700/50 rounded flex items-center gap-2">
                  <div 
                    className="w-8 h-8 rounded border border-gray-600"
                    style={{ 
                      backgroundColor: selectedMaterial.color,
                      backgroundImage: selectedMaterial.textureUrl ? `url(${selectedMaterial.thumbnail})` : undefined,
                      backgroundSize: 'cover',
                    }}
                  />
                  <div className="flex-1">
                    <div className="text-sm text-white">{selectedMaterial.name}</div>
                    <div className="text-xs text-gray-400">
                      ${selectedMaterial.pricePerSqFt + selectedMaterial.laborPerSqFt}/sq ft
                    </div>
                  </div>
                </div>
              )}
              
              {/* Action Buttons */}
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setActiveRenovationId(renovation.id);
                    const renovationType = renovation.zone.type;
                    setMaterialCategory(
                      renovationType === 'flooring' ? 'flooring' :
                      (renovationType === 'paint' || renovationType === 'walls') ? 'paint' :
                      'countertop'
                    );
                    setShowMaterialPicker(true);
                  }}
                  disabled={!segment}
                  className="flex-1 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-600 disabled:cursor-not-allowed rounded text-sm text-white"
                >
                  {selectedMaterial ? 'Change' : 'Material'}
                </button>
                
                {/* Method-specific Apply Button */}
                {renovationMethod === 'triplanar' ? (
                  /* Triplanar Renovation Button (NEW - Recommended) */
                  <button
                    onClick={() => performTriplanarRenovation(renovation.id)}
                    disabled={!segment || isPerformingTriplanar || !calibration}
                    className="px-3 py-1.5 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-400 hover:to-amber-400 disabled:from-gray-600 disabled:to-gray-600 disabled:cursor-not-allowed rounded text-sm text-white font-medium"
                    title="Triplanar texture projection - real-time, correct from all angles"
                  >
                    {isPerformingTriplanar && activeRenovationId === renovation.id ? (
                      <span className="flex items-center gap-1">
                        <div className="animate-spin">⚙️</div>
                        Applying...
                      </span>
                    ) : (
                      '⚡ Apply'
                    )}
                  </button>
                ) : renovationMethod === 'multiview' ? (
                  /* Multi-View Retexturing Button (Best Quality) */
                  <div className="flex gap-1">
                    <button
                      onClick={() => performMultiViewRetexturing(renovation.id, undefined, true)}
                      disabled={!meshGroup || isPerformingRetexturing}
                      className="px-2 py-1.5 bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-500 hover:to-emerald-500 disabled:from-gray-600 disabled:to-gray-600 disabled:cursor-not-allowed rounded text-xs text-white font-medium"
                      title="Quick preview - Shows Gemini-edited views"
                    >
                      {isPerformingRetexturing && activeRenovationId === renovation.id ? (
                        <span className="flex items-center gap-1">
                          <div className="animate-spin text-xs">⚙️</div>
                        </span>
                      ) : (
                        '👁️'
                      )}
                    </button>
                    <button
                      onClick={() => performMultiViewRetexturing(renovation.id)}
                      disabled={!meshGroup || isPerformingRetexturing}
                      className="px-3 py-1.5 bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-500 hover:to-emerald-500 disabled:from-gray-600 disabled:to-gray-600 disabled:cursor-not-allowed rounded text-sm text-white font-medium"
                      title="Full retexturing - Uses OpenMVS on GCP"
                    >
                      {isPerformingRetexturing && activeRenovationId === renovation.id ? (
                        <span className="flex items-center gap-1">
                          <div className="animate-spin">⚙️</div>
                        </span>
                      ) : (
                        '🚀 Apply'
                      )}
                    </button>
                  </div>
                ) : renovationMethod === 'uv' ? (
                  /* UV Edit Button */
                  <button
                    onClick={() => performUVBasedRenovation(renovation.id)}
                    disabled={!segment || isPerformingUVRenovation || !segmentation}
                    className="px-3 py-1.5 bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-500 hover:to-pink-500 disabled:from-gray-600 disabled:to-gray-600 disabled:cursor-not-allowed rounded text-sm text-white font-medium"
                    title="Edit UV texture directly - preserves lighting & shadows"
                  >
                    {isPerformingUVRenovation && activeRenovationId === renovation.id ? (
                      <span className="flex items-center gap-1">
                        <div className="animate-spin">⚙️</div>
                        UV
                      </span>
                    ) : (
                      '🎨 UV'
                    )}
                  </button>
                ) : (
                  /* Legacy AI Texture Button */
                  <button
                    onClick={() => generateAndApplyAITexture(renovation.id)}
                    disabled={!segment || isGeneratingAITexture || !calibration}
                    className="px-3 py-1.5 bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500 disabled:from-gray-600 disabled:to-gray-600 disabled:cursor-not-allowed rounded text-sm text-white font-medium"
                    title="Generate AI tileable texture"
                  >
                    {isGeneratingAITexture && activeRenovationId === renovation.id ? (
                      <span className="flex items-center gap-1">
                        <div className="animate-spin">⚙️</div>
                        AI
                      </span>
                    ) : (
                      '🤖 AI'
                    )}
                  </button>
                )}
              </div>
              
              {/* AI Texture Status */}
              {appliedAITextures.has(renovation.id) && (
                <div className="mt-2 p-2 bg-blue-900/30 border border-blue-500/30 rounded">
                  <div className="text-xs text-blue-300 flex items-center gap-1">
                    🤖 AI tileable texture applied
                  </div>
                </div>
              )}
              
              {/* UV Renovation Status */}
              {uvRenovationResults.has(renovation.id) && (
                <div className="mt-2 p-2 bg-purple-900/30 border border-purple-500/30 rounded">
                  <div className="text-xs text-purple-300 flex items-center gap-1">
                    ✨ UV texture edited - lighting preserved!
                  </div>
                  <div className="text-xs text-purple-400 mt-1">
                    Coverage: {((uvRenovationResults.get(renovation.id)?.surfaceMask?.coverage || 0) * 100).toFixed(1)}%
                  </div>
                </div>
              )}
              
              {/* Triplanar Renovation Status */}
              {triplanarResults.has(renovation.id) && (
                <div className="mt-2 p-2 bg-orange-900/30 border border-orange-500/30 rounded">
                  <div className="text-xs text-orange-300 flex items-center gap-1">
                    ⚡ Triplanar texture applied - view from any angle!
                  </div>
                  <button
                    onClick={() => {
                      const result = triplanarResults.get(renovation.id);
                      if (result?.restore) {
                        result.restore();
                        setTriplanarResults(prev => {
                          const next = new Map(prev);
                          next.delete(renovation.id);
                          return next;
                        });
                        setSelections(prev => prev.filter(s => s.renovationId !== renovation.id));
                      }
                    }}
                    className="mt-1 text-xs text-orange-400 hover:text-orange-300 underline"
                  >
                    Restore original
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      
      {/* Material Picker Modal */}
      {showMaterialPicker && (
        <MaterialPicker
          category={materialCategory}
          onSelect={(materialId) => {
            if (activeRenovationId) {
              applyMaterial(activeRenovationId, materialId);
            }
          }}
          onClose={() => setShowMaterialPicker(false)}
        />
      )}
      
      {/* Cost Summary */}
      {selections.length > 0 && (
        <div className="p-4 border-t border-gray-700 bg-gray-800/50">
          <div className="flex justify-between mb-2">
            <span className="text-gray-400">Materials</span>
            <span className="text-white">${costBreakdown.materials.toLocaleString()}</span>
          </div>
          <div className="flex justify-between mb-2">
            <span className="text-gray-400">Labor</span>
            <span className="text-white">${costBreakdown.labor.toLocaleString()}</span>
          </div>
          <div className="flex justify-between text-lg font-bold">
            <span className="text-white">Total</span>
            <span className="text-green-400">${costBreakdown.total.toLocaleString()}</span>
          </div>
        </div>
      )}
      
      {/* Actions */}
      <div className="p-4 border-t border-gray-700 flex gap-2">
        <button
          onClick={resetAll}
          disabled={selections.length === 0}
          className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-500 rounded text-white text-sm"
        >
          Reset
        </button>
        <button
          onClick={() => {
            // TODO: Pass renderer/camera/scene
            // generateRender(renderer, camera, scene);
            console.log('[RenovationPreview] Generate render - needs Three.js context');
          }}
          disabled={selections.length === 0 || isGenerating}
          className="flex-1 px-4 py-2 bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 disabled:from-gray-700 disabled:to-gray-700 rounded text-white text-sm font-medium"
        >
          {isGenerating ? 'Generating...' : '✨ Generate Photorealistic Preview'}
        </button>
      </div>
      
      {/* Generated Image */}
      {generatedImage && (
        <div className="p-4 border-t border-gray-700">
          <div className="text-sm text-gray-400 mb-2">AI-Enhanced Preview:</div>
          <img 
            src={generatedImage} 
            alt="Renovation preview" 
            className="w-full rounded-lg"
          />
        </div>
      )}
      
      {/* Preview Gallery Modal */}
      {showPreviewGallery && previewViews.length > 0 && (
        <div className="fixed inset-0 bg-black/90 z-50 flex flex-col">
          <div className="flex items-center justify-between p-4 border-b border-gray-700">
            <h3 className="text-lg font-bold text-white flex items-center gap-2">
              🎨 Renovation Preview Gallery
              <span className="text-sm font-normal text-gray-400">
                ({previewViews.length} views)
              </span>
            </h3>
            <button 
              onClick={() => setShowPreviewGallery(false)}
              className="text-gray-400 hover:text-white text-2xl"
            >
              ×
            </button>
          </div>
          
          <div className="flex-1 overflow-y-auto p-4">
            <div className="grid grid-cols-2 gap-4">
              {previewViews.map((view, index) => (
                <div key={index} className="space-y-2">
                  <div className="text-sm text-gray-400 text-center">
                    {view.viewpoint.name}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <div className="text-xs text-gray-500 mb-1">Original</div>
                      <img 
                        src={view.originalImageDataUrl} 
                        alt={`Original ${view.viewpoint.name}`}
                        className="w-full rounded-lg border border-gray-700"
                      />
                    </div>
                    <div>
                      <div className="text-xs text-green-500 mb-1">Renovated</div>
                      <img 
                        src={view.editedImageDataUrl} 
                        alt={`Edited ${view.viewpoint.name}`}
                        className="w-full rounded-lg border border-green-700"
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
          
          <div className="p-4 border-t border-gray-700 flex gap-3">
            <button
              onClick={() => setShowPreviewGallery(false)}
              className="flex-1 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-white"
            >
              Close Preview
            </button>
            <button
              onClick={() => {
                setShowPreviewGallery(false);
                // Trigger full retexturing with the active renovation
                if (activeRenovationId) {
                  performMultiViewRetexturing(activeRenovationId, undefined, false);
                }
              }}
              disabled={isPerformingRetexturing}
              className="flex-1 py-2 bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-500 hover:to-emerald-500 disabled:from-gray-600 disabled:to-gray-600 rounded-lg text-white font-medium"
            >
              🚀 Apply to 3D Model
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Material Picker Sub-Component
// ============================================================================

interface MaterialPickerProps {
  category: 'flooring' | 'paint' | 'countertop';
  onSelect: (materialId: string) => void;
  onClose: () => void;
}

function MaterialPicker({ category, onSelect, onClose }: MaterialPickerProps) {
  const materials = useMemo(() => {
    switch (category) {
      case 'flooring': return FLOORING_MATERIALS;
      case 'paint': return PAINT_MATERIALS;
      case 'countertop': return COUNTERTOP_MATERIALS;
      default: return [];
    }
  }, [category]);
  
  return (
    <div className="absolute inset-0 bg-gray-900/98 flex flex-col">
      <div className="flex items-center justify-between p-4 border-b border-gray-700">
        <h4 className="text-white font-medium capitalize">Select {category}</h4>
        <button onClick={onClose} className="text-gray-400 hover:text-white">×</button>
      </div>
      
      <div className="flex-1 overflow-y-auto p-4 grid grid-cols-2 gap-3">
        {materials.map((material) => (
          <button
            key={material.id}
            onClick={() => onSelect(material.id)}
            className="p-3 bg-gray-800 hover:bg-gray-700 rounded-lg border border-gray-700 hover:border-blue-500 transition-colors text-left"
          >
            <div 
              className="w-full h-20 rounded mb-2 border border-gray-600"
              style={{ 
                backgroundColor: material.color,
                backgroundImage: material.textureUrl ? `url(${material.thumbnail})` : undefined,
                backgroundSize: 'cover',
              }}
            />
            <div className="text-sm text-white font-medium truncate">{material.name}</div>
            <div className="text-xs text-gray-400">
              ${material.pricePerSqFt + material.laborPerSqFt}/sq ft
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

export default RenovationPreviewSystem;
