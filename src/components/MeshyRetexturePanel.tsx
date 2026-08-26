/**
 * Meshy Retexture Panel
 * 
 * UI for AI-powered mesh retexturing using Meshy AI:
 * - Apply new textures to 3D room scans
 * - Visualize renovations (e.g., replace carpet with hardwood)
 * - Generate PBR-ready materials
 * 
 * SEGMENTED MODE (New!):
 * - Uses Trimesh to extract specific surfaces (floor/walls/countertops)
 * - Generates seamless texture with Gemini Nano Banana Pro
 * - Applies texture only to the selected surface via Meshy
 * - Reassembles parts automatically using world coordinates
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  createMeshyRetextureTask,
  downloadMeshyModel,
  pollMeshyRetextureUntilDone,
  getMeshyHistory,
  getActiveMeshyTasks,
  cancelMeshyTask,
  type MeshyRetextureStatus,
  type MeshyHistoryItem,
} from '../services/meshEditingService';

// Segmented retexture pipeline (backend Python/Trimesh)
import {
  runSegmentedRetexturePipeline,
  type PipelineProgress,
  type SegmentedRetextureResult,
} from '../services/segmentedRetextureService';

// Mesh preprocessing for fixing photogrammetry scans before Meshy
import {
  autoPreprocessMesh,
  analyzeMesh,
  checkPreprocessingService,
  getRepairSummary,
  segmentFloor,
  stitchFloor,
  type MeshAnalysis,
  type FloorSegmentationResult,
} from '../services/meshPreprocessingService';

import * as THREE from 'three';

// Preset renovation materials for quick selection
// NOTE: Prompts are enhanced server-side to apply uniformly to all surfaces
// Keys match the seamless-texture.js MATERIAL_DESCRIPTIONS for segmented mode
const RENOVATION_PRESETS = {
  flooring: [
    { name: 'Oak Hardwood', key: 'oak-hardwood', prompt: 'polished warm oak hardwood floor surface, natural wood grain planks, high detail, realistic wood texture covering the entire floor' },
    { name: 'Walnut Hardwood', key: 'walnut-hardwood', prompt: 'dark walnut hardwood floor planks, rich brown wood tones, natural wood texture, premium quality floor covering' },
    { name: 'Light Maple', key: 'light-maple', prompt: 'light maple hardwood floor planks, blonde wood floor, clean modern look, realistic wood grain pattern' },
    { name: 'Herringbone Parquet', key: 'herringbone-parquet', prompt: 'herringbone pattern parquet floor, medium oak wood planks arranged in herringbone, classic elegant floor design' },
    { name: 'White Oak Wide Plank', key: 'white-oak-wide-plank', prompt: 'wide plank white oak floor, light natural wood color, rustic farmhouse style floor planks' },
    { name: 'Gray Vinyl Plank', key: 'gray-vinyl-plank', prompt: 'modern gray vinyl plank floor, waterproof laminate look floor covering, contemporary style flooring' },
    { name: 'Marble Tile', key: 'marble-tile', prompt: 'white Carrara marble tile floor, polished marble finish, elegant luxury floor tiles' },
    { name: 'Slate Tile', key: 'slate-tile', prompt: 'natural slate tile floor, gray stone texture floor tiles, rustic modern flooring' },
  ],
  walls: [
    { name: 'White Paint', key: 'white-paint', prompt: 'clean white painted wall, smooth matte finish, bright and airy' },
    { name: 'Warm Gray', key: 'warm-gray', prompt: 'warm gray painted wall, sophisticated modern color, eggshell finish' },
    { name: 'Navy Blue', key: 'navy-blue', prompt: 'deep navy blue painted wall, bold accent color, satin finish' },
    { name: 'Sage Green', key: 'sage-green', prompt: 'soft sage green painted wall, natural calming color, matte finish' },
    { name: 'Exposed Brick', key: 'exposed-brick', prompt: 'exposed red brick wall, industrial loft style, rustic texture' },
    { name: 'White Shiplap', key: 'white-shiplap', prompt: 'white shiplap wall paneling, farmhouse style, horizontal boards' },
    { name: 'Wood Paneling', key: 'wood-paneling', prompt: 'natural wood paneling, warm brown tones, mid-century modern' },
    { name: 'Beadboard', key: 'beadboard', prompt: 'white beadboard wainscoting, classic cottage style, vertical lines' },
  ],
  countertops: [
    { name: 'White Quartz', key: 'white-quartz', prompt: 'white quartz countertop, clean modern look, subtle veining' },
    { name: 'Black Granite', key: 'black-granite', prompt: 'black granite countertop with gold flecks, polished luxury surface' },
    { name: 'Butcher Block', key: 'butcher-block', prompt: 'butcher block wood countertop, warm maple, kitchen island style' },
    { name: 'Marble', key: 'marble', prompt: 'white marble countertop with gray veining, classic elegant surface' },
    { name: 'Concrete', key: 'concrete', prompt: 'polished concrete countertop, industrial modern, smooth gray' },
  ],
};

interface FloorMeasurement {
  width: number;  // in mesh units
  depth: number;  // in mesh units
  widthFeet?: number;
  depthFeet?: number;
  floorY: number;
  centerX: number;
  centerZ: number;
  // All 4 floor points for plane calculation (width1, width2, depth1, depth2)
  floorPoints?: [number, number, number][];
}

interface MeshyRetexturePanelProps {
  meshUrl: string | null;
  onMeshUpdated: (newMeshUrl: string) => void;
  onSegmentedResult?: (result: SegmentedRetextureResult) => void; // For loading segmented parts
  onCaptureViewport?: () => Promise<string>; // Capture Three.js viewport as base64 image
  onRequestFloorMeasurement?: () => void; // Request user to measure floor
  floorMeasurement?: FloorMeasurement | null; // Measured floor dimensions from parent
  onPreprocessedMeshReady?: (preprocessedUrl: string) => void; // Notify parent when preprocessed mesh is ready
  onClose?: () => void;
}

export const MeshyRetexturePanel: React.FC<MeshyRetexturePanelProps> = ({
  meshUrl,
  onMeshUpdated,
  onSegmentedResult,
  onCaptureViewport,
  onRequestFloorMeasurement,
  floorMeasurement,
  onPreprocessedMeshReady,
  onClose,
}) => {
  // Task state
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState<string>('');
  const [progressPercent, setProgressPercent] = useState(0);
  const [error, setError] = useState<string | null>(null);
  
  // Mode toggle: 'full' (original), 'segmented' (mesh segmentation), 'overlay' (simple), or 'floor-only' (NEW - best for flooring!)
  const [retextureMode, setRetextureMode] = useState<'full' | 'segmented' | 'overlay' | 'floor-only'>('floor-only');
  
  // Floor-only mode state (new segmentation pipeline)
  const [floorSegmentation, setFloorSegmentation] = useState<FloorSegmentationResult | null>(null);
  const [isSegmentingFloor, setIsSegmentingFloor] = useState(false);
  
  // Pipeline progress for segmented mode
  const [pipelineStage, setPipelineStage] = useState<string>('');
  
  // Segment preview state
  const [showSegmentPreview, setShowSegmentPreview] = useState(false);
  const [previewGeometry, setPreviewGeometry] = useState<THREE.BufferGeometry | null>(null);
  const [previewStats, setPreviewStats] = useState<{ faces: number; area: number } | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const previewRendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const previewSceneRef = useRef<THREE.Scene | null>(null);
  const previewCameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const previewAnimationRef = useRef<number | null>(null);
  
  // Texture preview state
  const [generatedTextureUrl, setGeneratedTextureUrl] = useState<string | null>(null);
  const [isGeneratingPreview, setIsGeneratingPreview] = useState(false);
  
  // Floor overlay state (new simple approach)
  const [floorImagePreview, setFloorImagePreview] = useState<string | null>(null);
  const [floorOverlayResult, setFloorOverlayResult] = useState<any | null>(null);
  
  // Form state
  const [activeCategory, setActiveCategory] = useState<'flooring' | 'walls' | 'countertops'>('flooring');
  const [customPrompt, setCustomPrompt] = useState('');
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
  const [artStyle, setArtStyle] = useState<'realistic' | 'cartoon' | 'low-poly' | 'sculpture' | 'pbr'>('realistic');
  const [enablePBR, setEnablePBR] = useState(true);
  const [resolution, setResolution] = useState<'1024' | '2048' | '4096'>('2048');
  
  // Mesh preprocessing state (for fixing photogrammetry scans before Meshy)
  const [preprocessingAvailable, setPreprocessingAvailable] = useState<boolean | null>(null);
  const [meshAnalysis, setMeshAnalysis] = useState<MeshAnalysis | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [preprocessedUrl, setPreprocessedUrl] = useState<string | null>(null);
  const [isPreprocessing, setIsPreprocessing] = useState(false); // Manual preprocessing in progress
  const [preprocessingResult, setPreprocessingResult] = useState<{
    originalFaces: number;
    finalFaces: number;
    reductionPercent: number;
    normalFixed: boolean;
    floorAligned?: boolean;
    skirtClipped?: boolean;
    junkRemoved?: number;
    processingTimeMs: number;
  } | null>(null);
  const [autoPreprocess, setAutoPreprocess] = useState(true); // Auto-preprocess before Meshy
  const [imagePrompt, setImagePrompt] = useState('');
  const [viewingPreprocessed, setViewingPreprocessed] = useState(false); // Track which mesh is displayed
  
  // Reference image generation state (Gemini-generated image for Meshy style reference)
  const [referenceImageUrl, setReferenceImageUrl] = useState<string | null>(null);
  const [isGeneratingReferenceImage, setIsGeneratingReferenceImage] = useState(false);
  const [useReferenceImage, setUseReferenceImage] = useState(true); // Toggle to use the generated image
  
  // History state
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<MeshyHistoryItem[]>([]);
  const [activeTasks, setActiveTasks] = useState<Array<{ jobId: string; status: string; textPrompt: string }>>([]);
  
  // Load history on mount
  useEffect(() => {
    loadHistory();
    loadActiveTasks();
    checkPreprocessing();
  }, []);
  
  // Check preprocessing service availability
  const checkPreprocessing = async () => {
    try {
      const status = await checkPreprocessingService();
      setPreprocessingAvailable(status.available);
      if (!status.available) {
        console.warn('[MeshyRetexture] Preprocessing not available:', status.error);
      } else {
        console.log('[MeshyRetexture] ✅ Preprocessing service available');
      }
    } catch (e) {
      console.error('[MeshyRetexture] Failed to check preprocessing:', e);
      setPreprocessingAvailable(false);
    }
  };
  
  // Analyze mesh when meshUrl changes
  useEffect(() => {
    if (meshUrl && preprocessingAvailable) {
      handleAnalyzeMesh();
    }
  }, [meshUrl, preprocessingAvailable]);
  
  // Analyze mesh health
  const handleAnalyzeMesh = async () => {
    if (!meshUrl) return;
    
    setIsAnalyzing(true);
    setMeshAnalysis(null);
    setPreprocessedUrl(null);
    setPreprocessingResult(null);
    setViewingPreprocessed(false);
    
    try {
      const result = await analyzeMesh(meshUrl);
      if (result.success) {
        setMeshAnalysis(result.analysis);
        console.log('[MeshyRetexture] Mesh analysis:', result.analysis);
        console.log('[MeshyRetexture] Needs repair:', result.needsRepair);
        if (result.repairRecommendations.length > 0) {
          console.log('[MeshyRetexture] Recommendations:', result.repairRecommendations);
        }
      }
    } catch (e: any) {
      console.error('[MeshyRetexture] Mesh analysis failed:', e);
      // Don't show error to user, just proceed without analysis
    } finally {
      setIsAnalyzing(false);
    }
  };
  
  // Manually preprocess the mesh (repair & optimize for Meshy)
  const handleManualPreprocess = async () => {
    if (!meshUrl) return;
    
    setIsPreprocessing(true);
    setError(null);
    
    try {
      console.log('[MeshyRetexture] 🔧 Starting manual preprocessing...');
      
      const result = await autoPreprocessMesh(meshUrl, {
        targetFaces: 100000,
        forceRepair: true, // Force repair even if mesh seems healthy
      });
      
      if (result.success && result.wasPreprocessed) {
        setPreprocessedUrl(result.meshUrl);
        setPreprocessingResult({
          originalFaces: result.originalAnalysis?.face_count || 0,
          finalFaces: result.finalAnalysis?.face_count || 0,
          reductionPercent: result.repairs?.decimation?.reduction_percent || 0,
          normalFixed: result.repairs?.normals_fixed || false,
          floorAligned: result.repairs?.floor_aligned || false,
          skirtClipped: (result.repairs?.skirt_faces_clipped || 0) > 0,
          junkRemoved: result.repairs?.disconnected_components_removed || 0,
          processingTimeMs: result.processingTimeMs || 0,
        });
        
        console.log('[MeshyRetexture] ✅ Preprocessing complete:', result.meshUrl);
        console.log('[MeshyRetexture] Repairs:', result.repairs);
        
        // Notify parent that preprocessed mesh is ready
        if (onPreprocessedMeshReady) {
          onPreprocessedMeshReady(result.meshUrl);
        }
      } else if (result.success && !result.wasPreprocessed) {
        // Mesh was already healthy, use original
        setPreprocessedUrl(meshUrl);
        setError('Mesh is already optimized - no preprocessing needed');
      } else {
        throw new Error(result.error || 'Preprocessing failed');
      }
    } catch (e: any) {
      console.error('[MeshyRetexture] Manual preprocessing failed:', e);
      setError(`Preprocessing failed: ${e.message}`);
    } finally {
      setIsPreprocessing(false);
    }
  };
  
  // Switch viewer to preprocessed mesh
  const handleViewPreprocessed = () => {
    if (preprocessedUrl) {
      onMeshUpdated(preprocessedUrl);
      setViewingPreprocessed(true);
    }
  };
  
  // Switch viewer back to original mesh
  const handleViewOriginal = () => {
    if (meshUrl) {
      onMeshUpdated(meshUrl);
      setViewingPreprocessed(false);
    }
  };
  
  // Download preprocessed mesh as GLB
  const handleDownloadPreprocessed = () => {
    if (!preprocessedUrl) return;
    
    // Create download link
    const link = document.createElement('a');
    link.href = preprocessedUrl;
    link.download = `preprocessed_mesh_${Date.now()}.glb`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    console.log('[MeshyRetexture] 📥 Downloading preprocessed mesh:', preprocessedUrl);
  };
  
  const loadHistory = async () => {
    try {
      const result = await getMeshyHistory();
      if (result.success) {
        setHistory(result.meshes);
      }
    } catch (e) {
      console.error('[MeshyRetexture] Failed to load history:', e);
    }
  };
  
  const loadActiveTasks = async () => {
    try {
      const result = await getActiveMeshyTasks();
      if (result.success) {
        setActiveTasks(result.tasks);
      }
    } catch (e) {
      console.error('[MeshyRetexture] Failed to load active tasks:', e);
    }
  };
  
  // Extract and preview segment geometry
  // Fetch segment preview from backend
  const extractSegmentPreview = useCallback(async () => {
    if (!meshUrl) {
      setError('No mesh URL available');
      return;
    }
    
    setIsGeneratingPreview(true);
    setError(null);
    
    try {
      // Map category to surface type
      const surfaceTypeMap: Record<string, string> = {
        'flooring': 'floor',
        'walls': 'walls',
        'countertops': 'countertops',
      };
      const surfaceType = surfaceTypeMap[activeCategory] || 'floor';
      
      console.log('[Preview] Fetching segment preview from backend for:', activeCategory);
      
      // Call backend to segment and get preview URL
      const response = await fetch('/api/mesh/segment-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          meshUrl,
          surfaceType,
        }),
      });
      
      const result = await response.json();
      
      if (result.success && result.segmentUrl) {
        // Load the OBJ segment as geometry for preview
        const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
        const loader = new OBJLoader();
        
        const obj = await new Promise<THREE.Group>((resolve, reject) => {
          loader.load(result.segmentUrl, resolve, undefined, reject);
        });
        
        // Extract geometry from loaded OBJ
        let previewGeo: THREE.BufferGeometry | null = null;
        obj.traverse((child) => {
          if (child instanceof THREE.Mesh && child.geometry && !previewGeo) {
            previewGeo = child.geometry.clone();
          }
        });
        
        if (previewGeo) {
          setPreviewGeometry(previewGeo);
          setPreviewStats({ 
            faces: result.faceCount || 0, 
            area: result.area || 0 
          });
          setShowSegmentPreview(true);
          console.log('[Preview] Segment preview loaded:', result.faceCount, 'faces');
        } else {
          throw new Error('No geometry found in segment');
        }
      } else {
        throw new Error(result.error || 'Failed to get segment preview');
      }
    } catch (error: any) {
      console.error('[Preview] Failed to load segment preview:', error);
      setError(`Preview failed: ${error.message}`);
    } finally {
      setIsGeneratingPreview(false);
    }
  }, [meshUrl, activeCategory]);
  
  // Setup preview renderer
  useEffect(() => {
    if (!showSegmentPreview || !previewGeometry || !previewCanvasRef.current) return;
    
    const canvas = previewCanvasRef.current;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    
    // Create scene
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a2e);
    previewSceneRef.current = scene;
    
    // Create camera
    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 1000);
    previewCameraRef.current = camera;
    
    // Create renderer
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    previewRendererRef.current = renderer;
    
    // Add mesh
    const material = new THREE.MeshStandardMaterial({
      color: activeCategory === 'flooring' ? 0x8B4513 :
             activeCategory === 'walls' ? 0x87CEEB :
             0x808080,
      roughness: 0.5,
      metalness: 0.1,
      side: THREE.DoubleSide,
    });
    const previewMesh = new THREE.Mesh(previewGeometry, material);
    scene.add(previewMesh);
    
    // Center camera on geometry
    previewGeometry.computeBoundingBox();
    const box = previewGeometry.boundingBox!;
    const center = new THREE.Vector3();
    box.getCenter(center);
    const size = new THREE.Vector3();
    box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);
    
    camera.position.set(center.x, center.y + maxDim * 0.5, center.z + maxDim * 1.5);
    camera.lookAt(center);
    
    // Add lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambientLight);
    const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
    directionalLight.position.set(5, 10, 7);
    scene.add(directionalLight);
    
    // Add grid helper
    const gridHelper = new THREE.GridHelper(maxDim * 2, 20, 0x444444, 0x222222);
    gridHelper.position.y = box.min.y - 0.01;
    scene.add(gridHelper);
    
    // Animation loop with rotation
    let angle = 0;
    const animate = () => {
      previewAnimationRef.current = requestAnimationFrame(animate);
      
      angle += 0.005;
      camera.position.x = center.x + Math.sin(angle) * maxDim * 1.5;
      camera.position.z = center.z + Math.cos(angle) * maxDim * 1.5;
      camera.lookAt(center);
      
      renderer.render(scene, camera);
    };
    animate();
    
    return () => {
      if (previewAnimationRef.current) {
        cancelAnimationFrame(previewAnimationRef.current);
      }
      renderer.dispose();
      material.dispose();
    };
  }, [showSegmentPreview, previewGeometry, activeCategory]);
  
  // Generate texture preview using Gemini
  const generateTexturePreview = useCallback(async () => {
    setIsGeneratingPreview(true);
    setError(null);
    
    try {
      // Get the effective material key
      const presets = RENOVATION_PRESETS[activeCategory];
      const matchingPreset = selectedPreset 
        ? presets.find(p => p.name === selectedPreset)
        : null;
      const materialKey = matchingPreset?.key || activeCategory;
      
      const textureSurfaceType = activeCategory === 'flooring' ? 'flooring' : 
                                 activeCategory === 'countertops' ? 'countertops' : 
                                 'walls';
      
      // Capture viewport for context
      let viewportImage: string | undefined;
      if (onCaptureViewport) {
        try {
          viewportImage = await onCaptureViewport();
        } catch (e) {
          console.warn('[MeshyRetexture] Failed to capture viewport:', e);
        }
      }
      
      console.log('[MeshyRetexture] Generating texture preview:', materialKey);
      
      const response = await fetch('/api/seamless-textures/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          surfaceType: textureSurfaceType,
          materialOption: materialKey,
          customPrompt: customPrompt || undefined,
          viewportImage,
        }),
      });
      
      const result = await response.json();
      
      if (result.success) {
        setGeneratedTextureUrl(result.textureUrl);
        console.log('[MeshyRetexture] Texture preview generated:', result.textureUrl);
      } else {
        throw new Error(result.error || 'Failed to generate texture');
      }
    } catch (error: any) {
      setError(`Texture generation failed: ${error.message}`);
      console.error('[MeshyRetexture] Texture preview error:', error);
    } finally {
      setIsGeneratingPreview(false);
    }
  }, [activeCategory, selectedPreset, customPrompt, onCaptureViewport]);
  
  // Generate a reference image using Gemini by editing the actual viewport
  // This captures what the user sees and applies the new flooring/material to it
  // Meshy uses this edited room image as a style reference for retexturing
  const handleGenerateReferenceImage = useCallback(async () => {
    const prompt = customPrompt.trim() || (selectedPreset ? RENOVATION_PRESETS[activeCategory].find(p => p.name === selectedPreset)?.prompt : null);
    
    if (!prompt) {
      setError('Please select a preset or enter a custom description first');
      return;
    }
    
    // Capture viewport is REQUIRED for room editing
    if (!onCaptureViewport) {
      setError('Viewport capture not available - cannot generate room preview');
      return;
    }
    
    setIsGeneratingReferenceImage(true);
    setError(null);
    
    try {
      console.log('[MeshyRetexture] 🏠 Generating room edit reference image...');
      console.log('[MeshyRetexture] Material prompt:', prompt);
      
      // Capture the current viewport (what user sees of the 3D model)
      let viewportImage: string;
      try {
        viewportImage = await onCaptureViewport();
        console.log('[MeshyRetexture] ✅ Captured viewport image');
      } catch (e: any) {
        throw new Error(`Failed to capture viewport: ${e.message}`);
      }
      
      // Get material key for the API
      const presets = RENOVATION_PRESETS[activeCategory];
      const matchingPreset = selectedPreset 
        ? presets.find(p => p.name === selectedPreset)
        : null;
      const materialKey = matchingPreset?.key || undefined;
      
      // Determine surface type from category
      const surfaceType = activeCategory === 'flooring' ? 'flooring' : 
                         activeCategory === 'countertops' ? 'countertops' : 'walls';
      
      // Call the room editing API - this applies the material to the actual room
      const response = await fetch('/api/seamless-textures/edit-room', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          viewportImage,
          surfaceType,
          materialDescription: prompt,
          materialOption: materialKey,
          preserveRoom: true, // Only change the specified surface
        }),
      });
      
      const result = await response.json();
      
      if (result.success && result.editedImageUrl) {
        setReferenceImageUrl(result.editedImageUrl);
        setUseReferenceImage(true);
        console.log('[MeshyRetexture] ✅ Room edit reference image generated:', result.editedImageUrl);
        console.log('[MeshyRetexture] Material applied:', result.material);
      } else {
        throw new Error(result.error || 'Failed to generate room preview');
      }
    } catch (error: any) {
      console.error('[MeshyRetexture] Room edit generation error:', error);
      setError(`Room preview failed: ${error.message}`);
    } finally {
      setIsGeneratingReferenceImage(false);
    }
  }, [activeCategory, selectedPreset, customPrompt, onCaptureViewport]);
  
  // Handle floor overlay preview (just the image, fast)
  const handleFloorOverlayPreview = useCallback(async () => {
    setIsGeneratingPreview(true);
    setError(null);
    
    try {
      // Capture viewport from current view
      let viewportImages: string[] = [];
      
      if (onCaptureViewport) {
        const viewportImage = await onCaptureViewport();
        viewportImages.push(viewportImage);
        console.log('[FloorOverlay] Captured viewport for context');
      }
      
      if (viewportImages.length === 0) {
        throw new Error('Could not capture viewport');
      }
      
      // Get material key from selected preset
      const presets = RENOVATION_PRESETS[activeCategory];
      const matchingPreset = selectedPreset 
        ? presets.find(p => p.name === selectedPreset)
        : presets[0]; // Default to first preset
      const materialKey = matchingPreset?.key || 'oak-hardwood';
      
      console.log('[FloorOverlay] Generating preview with material:', materialKey);
      
      const response = await fetch('/api/floor-overlay/generate-image-only', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          viewportImages,
          materialKey,
          customPrompt: customPrompt || undefined,
          roomContext: 'Interior room 3D photogrammetry scan for renovation visualization'
        })
      });
      
      const result = await response.json();
      
      if (result.success) {
        setFloorImagePreview(result.floorImageUrl);
        console.log('[FloorOverlay] Preview generated:', result.floorImageUrl);
      } else {
        throw new Error(result.error || 'Failed to generate preview');
      }
    } catch (error: any) {
      setError(`Floor preview failed: ${error.message}`);
      console.error('[FloorOverlay] Preview error:', error);
    } finally {
      setIsGeneratingPreview(false);
    }
  }, [activeCategory, selectedPreset, customPrompt, onCaptureViewport]);
  
  // Handle full floor overlay generation (image + 3D model)
  const handleFloorOverlayGenerate = useCallback(async () => {
    // Check if user has measured the floor
    if (!floorMeasurement) {
      // Request floor measurement first
      if (onRequestFloorMeasurement) {
        setPipelineStage('Please measure the floor dimensions...');
        onRequestFloorMeasurement();
        return;
      }
    }
    
    setIsProcessing(true);
    setError(null);
    setPipelineStage('Capturing room angles...');
    
    try {
      // Capture viewport
      let viewportImages: string[] = [];
      
      if (onCaptureViewport) {
        const viewportImage = await onCaptureViewport();
        viewportImages.push(viewportImage);
      }
      
      if (viewportImages.length === 0) {
        throw new Error('Could not capture viewport');
      }
      
      // Get material key
      const presets = RENOVATION_PRESETS[activeCategory];
      const matchingPreset = selectedPreset 
        ? presets.find(p => p.name === selectedPreset)
        : presets[0];
      const materialKey = matchingPreset?.key || 'oak-hardwood';
      
      setPipelineStage('Generating floor with Gemini...');
      console.log('[FloorOverlay] Starting full generation with:', materialKey);
      console.log('[FloorOverlay] Using floor measurement:', floorMeasurement);
      
      const response = await fetch('/api/floor-overlay/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          viewportImages,
          materialKey,
          customPrompt: customPrompt || undefined,
          floorBounds: null,
          roomContext: 'Interior room 3D photogrammetry scan'
        })
      });
      
      const result = await response.json();
      
      if (result.success) {
        setFloorOverlayResult(result);
        setFloorImagePreview(result.floorImageUrl);
        setPipelineStage('Complete!');
        console.log('[FloorOverlay] Generation complete:', result);
        
        // Notify parent to load the floor model WITH floor measurement
        if (onSegmentedResult) {
          onSegmentedResult({
            type: 'floor-overlay',
            modelUrl: result.floorModelUrl,
            placement: result.placement,
            floorMeasurement: floorMeasurement, // Pass measured dimensions
          } as any);
        }
      } else {
        throw new Error(result.error || 'Failed to generate floor overlay');
      }
    } catch (error: any) {
      setError(`Floor generation failed: ${error.message}`);
      console.error('[FloorOverlay] Generation error:', error);
    } finally {
      setIsProcessing(false);
      setPipelineStage('');
    }
  }, [activeCategory, selectedPreset, customPrompt, onCaptureViewport, onSegmentedResult, floorMeasurement, onRequestFloorMeasurement]);
  
  // Get the effective prompt (preset or custom)
  const getEffectivePrompt = useCallback(() => {
    if (customPrompt.trim()) {
      return customPrompt.trim();
    }
    if (selectedPreset) {
      const presets = RENOVATION_PRESETS[activeCategory];
      const preset = presets.find(p => p.name === selectedPreset);
      return preset?.prompt || '';
    }
    return '';
  }, [customPrompt, selectedPreset, activeCategory]);
  
  // Start retexturing
  const handleStartRetexture = useCallback(async () => {
    if (!meshUrl) {
      setError('No mesh loaded');
      return;
    }
    
    const prompt = getEffectivePrompt();
    if (!prompt) {
      setError('Please enter a prompt or select a preset');
      return;
    }
    
    setIsProcessing(true);
    setError(null);
    setProgress('Starting retexture...');
    setProgressPercent(5);
    setPipelineStage('');
    
    try {
      // --- SEGMENTED MODE: Use the new pipeline ---
      if (retextureMode === 'segmented') {
        // Find the selected preset to get the material key
        const presets = RENOVATION_PRESETS[activeCategory];
        const matchingPreset = presets.find(p => p.prompt === prompt);
        const materialKey = matchingPreset?.key || activeCategory;
        
        setPipelineStage('Capturing viewport');
        setProgress('Capturing your current view of the room...');
        setProgressPercent(2);
        
        // Capture the user's top-down viewport for context-aware texture generation
        let viewportScreenshot: string | undefined;
        if (onCaptureViewport) {
          try {
            viewportScreenshot = await onCaptureViewport();
            console.log('[MeshyRetexture] Viewport captured:', viewportScreenshot.substring(0, 50) + '...');
          } catch (captureError) {
            console.warn('[MeshyRetexture] Failed to capture viewport:', captureError);
            // Continue without viewport context
          }
        }
        
        setPipelineStage('Segmented Retexture Pipeline');
        setProgress('Starting segmented retexture pipeline...');
        setProgressPercent(5);
        
        // Map category to surface type (floor is special case)
        const surfaceTypeMap: Record<string, 'floor' | 'walls' | 'ceiling' | 'countertops'> = {
          'flooring': 'floor',
          'walls': 'walls', 
          'countertops': 'countertops',
        };
        const surfaceType = surfaceTypeMap[activeCategory] || 'floor';
        
        let result: SegmentedRetextureResult;
        
        // Use backend Python/Trimesh segmentation - more robust mesh processing
        console.log('[MeshyRetexture] Using backend Trimesh segmentation');
        result = await runSegmentedRetexturePipeline(
          meshUrl,
          surfaceType,
          materialKey,
          (progressInfo: PipelineProgress) => {
            setPipelineStage(progressInfo.stage);
            setProgress(`${progressInfo.stage}: ${progressInfo.message}`);
            setProgressPercent(progressInfo.progress);
          },
          customPrompt || undefined,
          viewportScreenshot
        );
        
        if (result.success && result.retexturedSegmentUrl) {
          setProgress('✅ Segmented retexture complete!');
          setProgressPercent(100);
          
          // Notify parent with segmented result so it can load both parts
          if (onSegmentedResult) {
            onSegmentedResult(result);
          } else {
            // Fallback: just update with the retextured segment
            onMeshUpdated(result.retexturedSegmentUrl);
          }
          
          // Refresh history
          loadHistory();
        } else {
          throw new Error(result.error || 'Segmented retexture failed');
        }
        
        return; // Exit early, segmented mode complete
      }
      
      // --- FLOOR-ONLY MODE: Best for flooring! Segments floor mesh, sends ONLY floor to Meshy, stitches back ---
      if (retextureMode === 'floor-only') {
        setPipelineStage('Floor Segmentation');
        setProgress('Extracting floor mesh from your 3D scan...');
        setProgressPercent(10);
        
        try {
          // Step 1: Segment the floor from the main mesh
          setIsSegmentingFloor(true);
          const segmentResult = await segmentFloor(meshUrl);
          
          if (!segmentResult.success || !segmentResult.floorUrl || !segmentResult.shellUrl) {
            throw new Error(segmentResult.error || 'Failed to segment floor from mesh');
          }
          
          setFloorSegmentation(segmentResult);
          console.log('[MeshyRetexture] ✅ Floor segmented:', {
            floorFaces: segmentResult.floorInfo?.floor_faces,
            shellFaces: segmentResult.floorInfo?.shell_faces
          });
          
          setProgress(`Floor segmented: ${segmentResult.floorInfo?.floor_faces || 0} faces. Sending to Meshy...`);
          setProgressPercent(25);
          
          // Step 2: Generate a reference image with Gemini if we have a viewport
          let referenceImage: string | undefined = referenceImageUrl || undefined;
          if (onCaptureViewport && !referenceImage) {
            try {
              setPipelineStage('Generating Reference');
              setProgress('Capturing viewport for AI reference image...');
              const viewportScreenshot = await onCaptureViewport();
              
              // Use the viewport screenshot as a reference for Meshy
              // In the future, we could call the edit-room endpoint to have Gemini
              // visualize the new flooring on the actual room photo
              setProgress('Using viewport capture as reference...');
              setProgressPercent(30);
              referenceImage = viewportScreenshot;
            } catch (captureError) {
              console.warn('[MeshyRetexture] Failed to capture viewport for reference:', captureError);
            }
          }
          
          // Step 3: Send ONLY the floor mesh to Meshy for retexturing
          setPipelineStage('Meshy Retexture');
          setProgress('Sending floor mesh to Meshy AI for retexturing...');
          setProgressPercent(35);
          
          const createResult = await createMeshyRetextureTask(segmentResult.floorUrl, prompt, {
            artStyle,
            enablePBR,
            resolution,
            imagePrompt: referenceImage,
            surfaceType: 'flooring',
            enableOriginalUV: false, // Let Meshy generate clean UVs
          });
          
          if (!createResult.success || !createResult.jobId) {
            throw new Error(createResult.error || 'Failed to create Meshy retexture task for floor');
          }
          
          setCurrentJobId(createResult.jobId);
          setProgress('Meshy is retexturing your floor...');
          setProgressPercent(40);
          
          // Poll for completion
          const finalStatus = await pollMeshyRetextureUntilDone(
            createResult.jobId,
            (status: MeshyRetextureStatus) => {
              const pct = 40 + (status.progress || 0) * 0.4; // 40% to 80%
              setProgressPercent(Math.min(pct, 80));
              setProgress(`Meshy: ${status.status} (${status.progress || 0}%)`);
            }
          );
          
          if (finalStatus.status !== 'SUCCEEDED') {
            throw new Error(finalStatus.error || `Meshy task failed: ${finalStatus.status}`);
          }
          
          // Step 4: Download the retextured floor
          setPipelineStage('Downloading');
          setProgress('Downloading retextured floor mesh...');
          setProgressPercent(82);
          
          const downloadResult = await downloadMeshyModel(createResult.jobId, 'glb');
          
          if (!downloadResult.success || !downloadResult.localUrl) {
            throw new Error(downloadResult.error || 'Failed to download retextured floor');
          }
          
          // Step 5: Stitch the textured floor back with the original shell
          setPipelineStage('Stitching');
          setProgress('Stitching textured floor back with original walls...');
          setProgressPercent(88);
          
          const stitchResult = await stitchFloor(segmentResult.shellUrl, downloadResult.localUrl);
          
          if (!stitchResult.success || !stitchResult.combinedUrl) {
            throw new Error(stitchResult.error || 'Failed to stitch floor back with shell');
          }
          
          // Done!
          setProgress('✅ Floor retexturing complete! Walls preserved perfectly.');
          setProgressPercent(100);
          
          onMeshUpdated(stitchResult.combinedUrl);
          loadHistory();
          
        } catch (floorError: any) {
          console.error('[MeshyRetexture] Floor-only pipeline error:', floorError);
          setError(floorError.message || 'Floor segmentation pipeline failed');
        } finally {
          setIsSegmentingFloor(false);
        }
        
        return; // Exit early, floor-only mode complete
      }
      
      // --- FULL MODEL MODE: Original Meshy retexture flow ---
      
      // Step 1: Preprocess the mesh if needed (fixes normals, removes degenerates, decimates)
      let meshToSend = meshUrl;
      
      if (autoPreprocess && preprocessingAvailable) {
        setProgress('Analyzing mesh for Meshy compatibility...');
        setPipelineStage('Preprocessing');
        setProgressPercent(2);
        
        try {
          const preprocessResult = await autoPreprocessMesh(meshUrl, {
            targetFaces: 100000,  // Meshy works better with ~100k faces
            forceRepair: false,   // Only repair if needed
          });
          
          if (preprocessResult.success) {
            if (preprocessResult.wasPreprocessed) {
              // Mesh was fixed
              meshToSend = preprocessResult.meshUrl;
              setPreprocessedUrl(preprocessResult.meshUrl);
              console.log('[MeshyRetexture] ✅ Mesh preprocessed:', getRepairSummary(preprocessResult as any));
              setProgress('Mesh repaired successfully. Creating retexture task...');
            } else {
              // Mesh was already healthy
              console.log('[MeshyRetexture] ✅ Mesh already healthy, no preprocessing needed');
              setProgress('Mesh healthy. Creating retexture task...');
            }
          }
        } catch (preprocessError: any) {
          console.warn('[MeshyRetexture] Preprocessing failed, continuing with original mesh:', preprocessError);
          // Continue with original mesh - Meshy might still work
        }
        
        setProgressPercent(8);
      }
      
      setProgress('Creating retexture task...');
      
      // Determine image reference to use
      // Priority: 1. Generated reference image (if enabled), 2. Manual image URL, 3. None
      const imageReference = (useReferenceImage && referenceImageUrl) 
        ? referenceImageUrl 
        : imagePrompt || undefined;
      
      if (imageReference) {
        console.log('[MeshyRetexture] 🖼️ Using image reference for Meshy:', imageReference.substring(0, 50) + '...');
      }
      
      // Create the task - use preprocessed mesh if available
      // Pass enable_original_uv: false to force Meshy to generate clean UVs
      const createResult = await createMeshyRetextureTask(meshToSend, prompt, {
        artStyle,
        enablePBR,
        resolution,
        imagePrompt: imageReference, // Use the generated reference image or manual URL
        surfaceType: activeCategory, // Tell Meshy which surface type to target
        enableOriginalUV: false, // Force Meshy to use its own clean UVs (critical for repaired meshes)
      });
      
      if (!createResult.success || !createResult.jobId) {
        throw new Error(createResult.error || 'Failed to create retexture task');
      }
      
      setCurrentJobId(createResult.jobId);
      setProgress('Retexture task created. Processing...');
      setProgressPercent(10);
      
      // Poll for completion
      const finalStatus = await pollMeshyRetextureUntilDone(
        createResult.jobId,
        (status: MeshyRetextureStatus) => {
          setProgressPercent(Math.min(10 + (status.progress || 0) * 0.8, 90));
          setProgress(`Processing: ${status.status} (${status.progress || 0}%)`);
        }
      );
      
      if (finalStatus.status === 'SUCCEEDED') {
        setProgress('Downloading retextured model...');
        setProgressPercent(92);
        
        // Download the model
        const downloadResult = await downloadMeshyModel(createResult.jobId, 'glb');
        
        if (downloadResult.success && downloadResult.localUrl) {
          setProgress('✅ Retexturing complete!');
          setProgressPercent(100);
          onMeshUpdated(downloadResult.localUrl);
          
          // Refresh history
          loadHistory();
        } else {
          throw new Error(downloadResult.error || 'Failed to download model');
        }
      } else {
        throw new Error(finalStatus.error || `Task failed with status: ${finalStatus.status}`);
      }
      
    } catch (e: any) {
      console.error('[MeshyRetexture] Error:', e);
      setError(e.message || 'Unknown error occurred');
      setProgress('');
    } finally {
      setIsProcessing(false);
      setCurrentJobId(null);
      setPipelineStage('');
      loadActiveTasks();
    }
  }, [meshUrl, getEffectivePrompt, artStyle, enablePBR, resolution, imagePrompt, referenceImageUrl, onMeshUpdated, onSegmentedResult, onCaptureViewport, retextureMode, activeCategory]);
  
  // Cancel current task
  const handleCancelTask = useCallback(async () => {
    if (currentJobId) {
      await cancelMeshyTask(currentJobId);
      setIsProcessing(false);
      setCurrentJobId(null);
      setProgress('Task cancelled');
      loadActiveTasks();
    }
  }, [currentJobId]);
  
  // Load a model from history
  const handleLoadFromHistory = useCallback((item: MeshyHistoryItem) => {
    onMeshUpdated(item.url);
    setShowHistory(false);
  }, [onMeshUpdated]);
  
  // Resume monitoring an active task
  const handleResumeTask = useCallback(async (jobId: string) => {
    setIsProcessing(true);
    setCurrentJobId(jobId);
    setProgress('Resuming task monitoring...');
    
    try {
      const finalStatus = await pollMeshyRetextureUntilDone(jobId, (status) => {
        setProgressPercent(Math.min(10 + (status.progress || 0) * 0.8, 90));
        setProgress(`Processing: ${status.status} (${status.progress || 0}%)`);
      });
      
      if (finalStatus.status === 'SUCCEEDED') {
        const downloadResult = await downloadMeshyModel(jobId, 'glb');
        if (downloadResult.success && downloadResult.localUrl) {
          setProgress('✅ Retexturing complete!');
          onMeshUpdated(downloadResult.localUrl);
          loadHistory();
        }
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setIsProcessing(false);
      setCurrentJobId(null);
      loadActiveTasks();
    }
  }, [onMeshUpdated]);
  
  return (
    <div className="bg-gray-900 text-white p-4 rounded-lg max-w-md w-full max-h-[80vh] overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="text-2xl">🎨</span>
          <h2 className="text-lg font-bold">AI Retexture</h2>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowHistory(!showHistory)}
            className="p-2 hover:bg-gray-700 rounded transition-colors"
            title="View History"
          >
            📁
          </button>
          {onClose && (
            <button
              onClick={onClose}
              className="p-2 hover:bg-gray-700 rounded transition-colors"
            >
              ✕
            </button>
          )}
        </div>
      </div>
      
      {/* Mesh URL Display */}
      {meshUrl && (
        <div className="bg-gray-800 rounded p-2 mb-4 text-sm">
          <span className="text-gray-400">Current mesh:</span>
          <div className="text-blue-400 truncate">{meshUrl}</div>
        </div>
      )}
      
      {!meshUrl && (
        <div className="bg-yellow-900/50 border border-yellow-600 rounded p-3 mb-4">
          <p className="text-yellow-400 text-sm">
            ⚠️ No mesh loaded. Please load a 3D scan first.
          </p>
        </div>
      )}
      
      {/* History Panel */}
      {showHistory && (
        <div className="bg-gray-800 rounded-lg p-3 mb-4">
          <h3 className="font-semibold mb-2">📁 Previous Retextures</h3>
          {history.length === 0 ? (
            <p className="text-gray-400 text-sm">No previous retextures found.</p>
          ) : (
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {history.map((item, idx) => (
                <div
                  key={idx}
                  className="flex items-center gap-2 p-2 bg-gray-700 rounded hover:bg-gray-600 cursor-pointer transition-colors"
                  onClick={() => handleLoadFromHistory(item)}
                >
                  {item.thumbnailUrl ? (
                    <img
                      src={item.thumbnailUrl}
                      alt="thumbnail"
                      className="w-12 h-12 object-cover rounded"
                    />
                  ) : (
                    <div className="w-12 h-12 bg-gray-600 rounded flex items-center justify-center">
                      🏠
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm truncate">{item.filename}</div>
                    <div className="text-xs text-gray-400">
                      {new Date(item.createdAt).toLocaleDateString()} • {(item.fileSize / 1024 / 1024).toFixed(1)} MB
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          
          {/* Active Tasks */}
          {activeTasks.length > 0 && (
            <div className="mt-4">
              <h4 className="font-medium text-sm mb-2">⏳ Active Tasks</h4>
              {activeTasks.map((task) => (
                <div key={task.jobId} className="flex items-center gap-2 p-2 bg-blue-900/50 rounded">
                  <span className="animate-pulse">🔄</span>
                  <div className="flex-1 text-sm truncate">{task.textPrompt}</div>
                  <button
                    onClick={() => handleResumeTask(task.jobId)}
                    className="text-xs bg-blue-600 px-2 py-1 rounded hover:bg-blue-500"
                  >
                    Resume
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      
      {/* Category Tabs */}
      <div className="flex gap-1 mb-4">
        {(['flooring', 'walls', 'countertops'] as const).map((cat) => (
          <button
            key={cat}
            onClick={() => {
              setActiveCategory(cat);
              setSelectedPreset(null);
            }}
            className={`flex-1 py-2 px-3 rounded text-sm font-medium transition-colors ${
              activeCategory === cat
                ? 'bg-blue-600 text-white'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
          >
            {cat === 'flooring' && '🪵'}
            {cat === 'walls' && '🧱'}
            {cat === 'countertops' && '🪨'}
            {' '}
            {cat.charAt(0).toUpperCase() + cat.slice(1)}
          </button>
        ))}
      </div>
      
      {/* Mode Toggle - Floor Only vs Overlay vs Segmented vs Full Model */}
      <div className="mb-4 p-3 bg-gray-800 rounded-lg">
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm font-medium">Retexture Mode</label>
          <div className="flex gap-1 flex-wrap">
            <button
              onClick={() => setRetextureMode('floor-only')}
              className={`px-3 py-1 text-xs rounded transition-colors ${
                retextureMode === 'floor-only'
                  ? 'bg-amber-600 text-white'
                  : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
              }`}
              title="BEST! Segments floor mesh, sends ONLY floor to Meshy, stitches back - preserves walls perfectly"
            >
              🏆 Floor Only
            </button>
            <button
              onClick={() => setRetextureMode('overlay')}
              className={`px-3 py-1 text-xs rounded transition-colors ${
                retextureMode === 'overlay'
                  ? 'bg-purple-600 text-white'
                  : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
              }`}
              title="AI generates a new floor as a 3D model overlay"
            >
              ✨ AI Overlay
            </button>
            <button
              onClick={() => setRetextureMode('segmented')}
              className={`px-3 py-1 text-xs rounded transition-colors ${
                retextureMode === 'segmented'
                  ? 'bg-green-600 text-white'
                  : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
              }`}
              title="Extracts floor geometry and retextures it"
            >
              🎯 Segmented
            </button>
            <button
              onClick={() => setRetextureMode('full')}
              className={`px-3 py-1 text-xs rounded transition-colors ${
                retextureMode === 'full'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
              }`}
              title="Retextures the entire model"
            >
              🏠 Full
            </button>
          </div>
        </div>
        <p className="text-xs text-gray-400">
          {retextureMode === 'floor-only'
            ? '🏆 RECOMMENDED: Extracts floor mesh via Trimesh, sends ONLY the floor to Meshy for retexturing, then stitches textured floor back with original walls. Walls stay perfect!'
            : retextureMode === 'overlay' 
            ? '✨ Gemini generates a floor image from your room angles, then Meshy creates a 3D floor overlay. No mesh segmentation needed!'
            : retextureMode === 'segmented' 
            ? `🎯 Extracts ${activeCategory} geometry and applies texture via Meshy retexture API.`
            : '⚠️ Applies texture to the entire model (may affect all surfaces).'}
        </p>
        
        {/* Floor segmentation status - show when in floor-only mode */}
        {retextureMode === 'floor-only' && floorSegmentation && (
          <div className="mt-2 p-2 bg-amber-900/30 rounded border border-amber-600/30">
            <p className="text-xs text-amber-200">
              ✅ Floor segmented: {floorSegmentation.floorInfo?.floor_faces || 0} faces | Shell: {floorSegmentation.floorInfo?.shell_faces || 0} faces
            </p>
          </div>
        )}
        
        {retextureMode === 'floor-only' && isSegmentingFloor && (
          <div className="mt-2 p-2 bg-amber-900/30 rounded border border-amber-600/30 animate-pulse">
            <p className="text-xs text-amber-200">
              ⏳ Segmenting floor mesh...
            </p>
          </div>
        )}
      </div>
      
      {/* Mesh Health Panel - Shows preprocessing status for Full mode */}
      {retextureMode === 'full' && preprocessingAvailable && (
        <div className="mb-4 p-3 bg-gray-800 rounded-lg border border-gray-700">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">🔧 Mesh Health</span>
              {isAnalyzing && (
                <span className="text-xs text-gray-400 animate-pulse">Analyzing...</span>
              )}
            </div>
            <button
              onClick={handleAnalyzeMesh}
              disabled={isAnalyzing || !meshUrl}
              className="text-xs px-2 py-1 bg-gray-700 rounded hover:bg-gray-600 disabled:opacity-50"
            >
              Re-analyze
            </button>
          </div>
          
          {meshAnalysis && (
            <div className="space-y-2">
              {/* Health Status */}
              <div className={`text-xs p-2 rounded ${
                meshAnalysis.is_winding_consistent && meshAnalysis.degenerate_count < 100 && meshAnalysis.face_count <= 150000
                  ? 'bg-green-900/50 text-green-300'
                  : 'bg-yellow-900/50 text-yellow-300'
              }`}>
                {meshAnalysis.is_winding_consistent && meshAnalysis.degenerate_count < 100 && meshAnalysis.face_count <= 150000
                  ? '✅ Mesh is ready for Meshy AI'
                  : '⚠️ Mesh needs preprocessing (will auto-repair)'}
              </div>
              
              {/* Stats Grid */}
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="bg-gray-700/50 p-2 rounded">
                  <span className="text-gray-400">Faces:</span>{' '}
                  <span className={meshAnalysis.face_count > 150000 ? 'text-yellow-400' : 'text-white'}>
                    {meshAnalysis.face_count.toLocaleString()}
                  </span>
                </div>
                <div className="bg-gray-700/50 p-2 rounded">
                  <span className="text-gray-400">Vertices:</span>{' '}
                  <span className="text-white">{meshAnalysis.vertex_count.toLocaleString()}</span>
                </div>
                <div className="bg-gray-700/50 p-2 rounded">
                  <span className="text-gray-400">Normals:</span>{' '}
                  <span className={meshAnalysis.is_winding_consistent ? 'text-green-400' : 'text-red-400'}>
                    {meshAnalysis.is_winding_consistent ? '✓ Consistent' : '✗ Inconsistent'}
                  </span>
                </div>
                <div className="bg-gray-700/50 p-2 rounded">
                  <span className="text-gray-400">Watertight:</span>{' '}
                  <span className={meshAnalysis.is_watertight ? 'text-green-400' : 'text-yellow-400'}>
                    {meshAnalysis.is_watertight ? '✓ Yes' : '○ No (normal)'}
                  </span>
                </div>
              </div>
              
              {/* Issues */}
              {(meshAnalysis.degenerate_count > 0 || !meshAnalysis.is_winding_consistent || meshAnalysis.face_count > 100000) && (
                <div className="text-xs text-gray-400">
                  <strong>Auto-repair will:</strong>
                  <ul className="mt-1 ml-4 list-disc">
                    {!meshAnalysis.is_winding_consistent && <li>Fix inverted normals (prevents blue model error)</li>}
                    {meshAnalysis.degenerate_count > 0 && <li>Remove {meshAnalysis.degenerate_count} degenerate faces</li>}
                    {meshAnalysis.face_count > 100000 && <li>Decimate to ~100k faces for faster processing</li>}
                  </ul>
                </div>
              )}
              
              {/* Auto-preprocess toggle */}
              <div className="flex items-center gap-2 pt-2 border-t border-gray-700">
                <input
                  type="checkbox"
                  id="autoPreprocess"
                  checked={autoPreprocess}
                  onChange={(e) => setAutoPreprocess(e.target.checked)}
                  className="w-4 h-4 rounded"
                />
                <label htmlFor="autoPreprocess" className="text-xs text-gray-300">
                  Auto-repair before sending to Meshy
                </label>
              </div>
              
              {/* Manual Preprocess Button */}
              <div className="pt-2">
                <button
                  onClick={handleManualPreprocess}
                  disabled={isPreprocessing || !meshUrl}
                  className="w-full text-xs px-3 py-2 bg-blue-600 text-white rounded hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {isPreprocessing ? (
                    <>
                      <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/>
                      </svg>
                      <span>Processing...</span>
                    </>
                  ) : (
                    <>
                      <span>🔧</span>
                      <span>Repair & Optimize Now</span>
                    </>
                  )}
                </button>
              </div>
              
              {/* Preprocessing Result */}
              {preprocessingResult && (
                <div className="mt-2 p-2 bg-green-900/30 border border-green-600/50 rounded text-xs">
                  <div className="text-green-300 font-medium mb-1">✅ Professional Preprocessing Complete</div>
                  <div className="grid grid-cols-2 gap-1 text-gray-300">
                    <span>Original faces: {preprocessingResult.originalFaces.toLocaleString()}</span>
                    <span>Final faces: {preprocessingResult.finalFaces.toLocaleString()}</span>
                    {preprocessingResult.reductionPercent > 0 && (
                      <span className="text-blue-300">Reduced by: {preprocessingResult.reductionPercent.toFixed(1)}%</span>
                    )}
                    {preprocessingResult.normalFixed && (
                      <span className="text-green-300">✓ Normals fixed</span>
                    )}
                    {preprocessingResult.floorAligned && (
                      <span className="text-green-300">✓ Floor leveled</span>
                    )}
                    {preprocessingResult.skirtClipped && (
                      <span className="text-green-300">✓ Skirt clipped</span>
                    )}
                    {preprocessingResult.junkRemoved && preprocessingResult.junkRemoved > 0 && (
                      <span className="text-yellow-300">Removed {preprocessingResult.junkRemoved} junk parts</span>
                    )}
                    <span className="col-span-2 text-gray-400">
                      Processed in {(preprocessingResult.processingTimeMs / 1000).toFixed(1)}s
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}
          
          {!meshAnalysis && !isAnalyzing && meshUrl && (
            <p className="text-xs text-gray-400">
              Click "Re-analyze" to check mesh health
            </p>
          )}
          
          {/* View/Download Preprocessed Mesh */}
          {preprocessedUrl && (
            <div className="mt-3 pt-3 border-t border-gray-600">
              <div className="text-xs text-green-400 mb-2">
                ✅ Preprocessed mesh ready: <span className="text-white font-mono">{preprocessedUrl.split('/').pop()}</span>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={viewingPreprocessed ? handleViewOriginal : handleViewPreprocessed}
                  className="flex-1 text-xs px-3 py-2 bg-purple-600 text-white rounded hover:bg-purple-500 flex items-center justify-center gap-1"
                >
                  {viewingPreprocessed ? (
                    <>
                      <span>👁️</span>
                      <span>View Original</span>
                    </>
                  ) : (
                    <>
                      <span>👁️</span>
                      <span>View Preprocessed</span>
                    </>
                  )}
                </button>
                <button
                  onClick={handleDownloadPreprocessed}
                  className="flex-1 text-xs px-3 py-2 bg-gray-600 text-white rounded hover:bg-gray-500 flex items-center justify-center gap-1"
                >
                  <span>📥</span>
                  <span>Download GLB</span>
                </button>
              </div>
              {viewingPreprocessed && (
                <div className="mt-2 text-xs text-purple-300 text-center">
                  Currently viewing preprocessed mesh
                </div>
              )}
            </div>
          )}
        </div>
      )}
      
      {/* Reference Image Generation Panel - Generate Gemini image for Meshy style reference */}
      {retextureMode === 'full' && (
        <div className="mb-4 p-3 bg-gradient-to-br from-purple-900/40 to-blue-900/40 rounded-lg border border-purple-600/50">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="text-lg">🏠</span>
              <span className="text-sm font-medium">Room Preview</span>
              <span className="text-xs text-purple-300 bg-purple-800/50 px-2 py-0.5 rounded">Gemini AI</span>
            </div>
            {referenceImageUrl && (
              <button
                onClick={() => setReferenceImageUrl(null)}
                className="text-xs text-gray-400 hover:text-red-400"
              >
                Clear
              </button>
            )}
          </div>
          
          <p className="text-xs text-gray-300 mb-3">
            Capture your current view and have Gemini apply the new {activeCategory} to it. 
            This creates a realistic preview that Meshy uses as a style reference.{' '}
            <span className="text-purple-300">Recommended for best results!</span>
          </p>
          
          {/* Generated Image Preview */}
          {referenceImageUrl && (
            <div className="mb-3">
              <div className="relative">
                <img 
                  src={referenceImageUrl} 
                  alt="Room with new material applied" 
                  className="w-full h-40 object-cover rounded border border-purple-500/50"
                />
                <div className="absolute bottom-2 left-2 text-xs bg-black/70 px-2 py-1 rounded">
                  ✅ Ready for Meshy
                </div>
                <div className="absolute top-2 right-2 text-xs bg-purple-600/90 px-2 py-1 rounded">
                  AI Preview
                </div>
              </div>
              
              {/* Toggle to use/ignore the reference image */}
              <label className="flex items-center gap-2 mt-2">
                <input
                  type="checkbox"
                  checked={useReferenceImage}
                  onChange={(e) => setUseReferenceImage(e.target.checked)}
                  className="w-4 h-4 rounded accent-purple-500"
                />
                <span className="text-xs text-gray-300">
                  Use this image as style reference for Meshy
                </span>
              </label>
            </div>
          )}
          
          {/* Generate Button */}
          <button
            onClick={handleGenerateReferenceImage}
            disabled={isGeneratingReferenceImage || isProcessing || (!customPrompt && !selectedPreset) || !onCaptureViewport}
            className="w-full px-4 py-2.5 text-sm font-medium bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 disabled:from-gray-600 disabled:to-gray-600 disabled:text-gray-400 rounded transition-all flex items-center justify-center gap-2"
          >
            {isGeneratingReferenceImage ? (
              <>
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Applying {activeCategory} with Gemini...
              </>
            ) : referenceImageUrl ? (
              <>📷 Capture & Preview Again</>
            ) : (
              <>📷 Capture & Preview {activeCategory === 'flooring' ? 'Flooring' : activeCategory === 'countertops' ? 'Countertops' : 'Walls'}</>
            )}
          </button>
          
          {!onCaptureViewport && (
            <p className="text-xs text-red-400 mt-2 text-center">
              ⚠️ Viewport capture not available
            </p>
          )}
          
          {!customPrompt && !selectedPreset && onCaptureViewport && (
            <p className="text-xs text-yellow-400 mt-2 text-center">
              ⚠️ Select a preset or enter a description first
            </p>
          )}
          
          {/* Info about how it works */}
          <div className="mt-3 p-2 bg-black/20 rounded text-xs text-gray-400">
            <strong className="text-gray-300">How it works:</strong>
            <ol className="mt-1 ml-4 list-decimal space-y-1">
              <li>Select a material preset or enter custom description</li>
              <li>Position your view of the room as desired</li>
              <li>Click "Capture & Preview" - Gemini applies the {activeCategory} to your actual room</li>
              <li>Click "Apply AI Texture" - Meshy uses this preview as a style guide</li>
            </ol>
          </div>
        </div>
      )}
      
      {/* AI Floor Overlay Mode */}
      {retextureMode === 'overlay' && (
        <div className="mb-4 p-3 bg-purple-900/30 rounded border border-purple-700">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-lg">🪄</span>
            <span className="text-sm font-medium">AI Floor Overlay</span>
          </div>
          
          <p className="text-xs text-gray-300 mb-3">
            This mode captures your room from multiple angles, has Gemini generate a matching floor with your chosen material, 
            then creates a 3D floor model to place in your scene.
          </p>
          
          {/* Floor Image Preview */}
          {floorImagePreview && (
            <div className="mb-3">
              <p className="text-xs text-gray-400 mb-1">Generated Floor:</p>
              <img 
                src={floorImagePreview} 
                alt="Generated floor preview" 
                className="w-full h-32 object-cover rounded border border-gray-600"
              />
            </div>
          )}
          
          {/* Floor Overlay Result */}
          {floorOverlayResult && (
            <div className="text-xs text-green-400 mb-2">
              ✅ Floor overlay ready! Model URL: {floorOverlayResult.floorModelUrl}
            </div>
          )}
          
          {/* Floor Measurement Status */}
          <div className="mb-3 p-2 rounded bg-gray-700/50">
            <p className="text-xs text-gray-400 mb-1">📏 Floor Dimensions:</p>
            {floorMeasurement ? (
              <div className="text-sm text-green-400">
                ✓ Width: {floorMeasurement.widthFeet?.toFixed(2) || floorMeasurement.width.toFixed(3)} {floorMeasurement.widthFeet ? 'ft' : 'units'}
                <br />
                ✓ Depth: {floorMeasurement.depthFeet?.toFixed(2) || floorMeasurement.depth.toFixed(3)} {floorMeasurement.depthFeet ? 'ft' : 'units'}
              </div>
            ) : (
              <div className="text-xs text-yellow-400">
                ⚠️ Not measured - click button below to measure
              </div>
            )}
          </div>
          
          {/* Measure Floor Button */}
          <button
            onClick={() => {
              if (onRequestFloorMeasurement) {
                onRequestFloorMeasurement();
              }
            }}
            disabled={isProcessing}
            className="w-full px-4 py-2 mb-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:bg-gray-600 disabled:text-gray-400 rounded transition-colors"
          >
            📐 {floorMeasurement ? 'Re-measure Floor' : 'Measure Floor Dimensions'}
          </button>
          
          {/* Preview Button */}
          <button
            onClick={handleFloorOverlayPreview}
            disabled={!meshUrl || isProcessing || isGeneratingPreview}
            className="w-full px-4 py-2 mb-2 text-sm bg-purple-600 hover:bg-purple-500 disabled:bg-gray-600 disabled:text-gray-400 rounded transition-colors"
          >
            {isGeneratingPreview ? '🔄 Generating Preview...' : '👁️ Preview Floor Image'}
          </button>
          
          {/* Generate 3D Floor Button */}
          <button
            onClick={handleFloorOverlayGenerate}
            disabled={!meshUrl || isProcessing || !floorMeasurement}
            className="w-full px-4 py-3 text-sm font-semibold bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-500 hover:to-pink-500 disabled:from-gray-600 disabled:to-gray-600 disabled:text-gray-400 rounded transition-colors"
          >
            {isProcessing 
              ? `🔄 ${pipelineStage || 'Processing...'}` 
              : !floorMeasurement 
                ? '📐 Measure floor first' 
                : '🪄 Generate 3D Floor Overlay'
            }
          </button>
        </div>
      )}
      
      {/* Segment Preview (Segmented Mode Only) */}
      {retextureMode === 'segmented' && (
        <div className="mb-4 p-3 bg-gray-800/50 rounded border border-gray-700">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium">🔍 Segment Preview</span>
            <button
              onClick={extractSegmentPreview}
              disabled={!meshUrl || isProcessing}
              className="px-3 py-1 text-xs bg-blue-600 hover:bg-blue-500 disabled:bg-gray-600 disabled:text-gray-400 rounded transition-colors"
            >
              {showSegmentPreview ? 'Refresh Preview' : 'Show Segment'}
            </button>
          </div>
          
          {!meshUrl ? (
            <p className="text-xs text-yellow-400">
              ⚠️ No mesh loaded
            </p>
          ) : !showSegmentPreview ? (
            <p className="text-xs text-gray-400">
              Click "Show Segment" to preview what will be sent to Meshy
            </p>
          ) : (
            <div className="space-y-2">
              {/* Preview Canvas */}
              <div className="relative">
                <canvas
                  ref={previewCanvasRef}
                  className="w-full h-32 rounded border border-gray-600"
                  style={{ width: '100%', height: '128px' }}
                />
                <button
                  onClick={() => setShowSegmentPreview(false)}
                  className="absolute top-1 right-1 w-5 h-5 bg-gray-900/80 rounded text-gray-400 hover:text-white text-xs"
                >
                  ✕
                </button>
              </div>
              
              {/* Stats */}
              {previewStats && (
                <div className="flex gap-4 text-xs">
                  <span className="text-green-400">
                    ✅ {previewStats.faces.toLocaleString()} faces
                  </span>
                  <span className="text-blue-400">
                    📐 {previewStats.area.toFixed(2)} m² area
                  </span>
                </div>
              )}
              
              <p className="text-xs text-gray-400">
                This is the exact geometry that will be sent to Meshy for retexturing.
                The rotating preview shows your extracted {activeCategory}.
              </p>
            </div>
          )}
        </div>
      )}
      
      {/* Texture Preview (Segmented Mode Only) */}
      {retextureMode === 'segmented' && (
        <div className="mb-4 p-3 bg-gray-800/50 rounded border border-gray-700">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium">🎨 Texture Preview</span>
            <button
              onClick={generateTexturePreview}
              disabled={isGeneratingPreview || (!customPrompt && !selectedPreset)}
              className="px-3 py-1 text-xs bg-purple-600 hover:bg-purple-500 disabled:bg-gray-600 disabled:text-gray-400 rounded transition-colors"
            >
              {isGeneratingPreview ? '⏳ Generating...' : 'Preview Texture'}
            </button>
          </div>
          
          {!selectedPreset && !customPrompt ? (
            <p className="text-xs text-gray-400">
              Select a preset or enter a custom prompt to preview the texture
            </p>
          ) : !generatedTextureUrl && !isGeneratingPreview ? (
            <p className="text-xs text-gray-400">
              Click "Preview Texture" to see the AI-generated seamless texture
            </p>
          ) : isGeneratingPreview ? (
            <div className="flex items-center gap-2 py-4">
              <div className="w-4 h-4 border-2 border-purple-400 border-t-transparent rounded-full animate-spin" />
              <span className="text-xs text-purple-300">Generating with Gemini...</span>
            </div>
          ) : generatedTextureUrl ? (
            <div className="space-y-2">
              {/* Texture Image */}
              <div className="relative">
                <img
                  src={generatedTextureUrl}
                  alt="Generated texture"
                  className="w-full h-32 object-cover rounded border border-gray-600"
                />
                <button
                  onClick={() => setGeneratedTextureUrl(null)}
                  className="absolute top-1 right-1 w-5 h-5 bg-gray-900/80 rounded text-gray-400 hover:text-white text-xs"
                >
                  ✕
                </button>
              </div>
              
              <p className="text-xs text-gray-400">
                This seamless texture will be applied to your {activeCategory} via Meshy.
              </p>
            </div>
          ) : null}
        </div>
      )}
      
      {/* Preset Selection */}
      <div className="mb-4">
        <label className="block text-sm font-medium mb-2">Quick Presets</label>
        <div className="grid grid-cols-2 gap-2 max-h-40 overflow-y-auto">
          {RENOVATION_PRESETS[activeCategory].map((preset) => (
            <button
              key={preset.name}
              onClick={() => {
                setSelectedPreset(preset.name);
                setCustomPrompt('');
              }}
              className={`p-2 text-xs rounded border transition-colors text-left ${
                selectedPreset === preset.name
                  ? 'border-blue-500 bg-blue-900/50 text-white'
                  : 'border-gray-600 bg-gray-800 text-gray-300 hover:border-gray-500'
              }`}
            >
              {preset.name}
            </button>
          ))}
        </div>
      </div>
      
      {/* Custom Prompt */}
      <div className="mb-4">
        <label className="block text-sm font-medium mb-2">
          Custom Description
          {selectedPreset && !customPrompt && (
            <span className="text-gray-400 font-normal ml-2">(or type to override preset)</span>
          )}
        </label>
        <textarea
          value={customPrompt}
          onChange={(e) => {
            setCustomPrompt(e.target.value);
            if (e.target.value) setSelectedPreset(null);
          }}
          placeholder="e.g., polished dark oak hardwood flooring with subtle grain pattern"
          className="w-full p-2 bg-gray-800 border border-gray-600 rounded text-sm resize-none focus:border-blue-500 focus:outline-none"
          rows={3}
        />
      </div>
      
      {/* Advanced Options */}
      <details className="mb-4">
        <summary className="cursor-pointer text-sm font-medium text-gray-400 hover:text-white">
          ⚙️ Advanced Options
        </summary>
        <div className="mt-3 space-y-3 pl-2">
          {/* Art Style */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">Art Style</label>
            <select
              value={artStyle}
              onChange={(e) => setArtStyle(e.target.value as any)}
              className="w-full p-2 bg-gray-800 border border-gray-600 rounded text-sm"
            >
              <option value="realistic">Realistic (Recommended)</option>
              <option value="pbr">PBR Material</option>
              <option value="sculpture">Sculpture</option>
              <option value="cartoon">Cartoon</option>
              <option value="low-poly">Low Poly</option>
            </select>
          </div>
          
          {/* Resolution */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">Texture Resolution</label>
            <select
              value={resolution}
              onChange={(e) => setResolution(e.target.value as any)}
              className="w-full p-2 bg-gray-800 border border-gray-600 rounded text-sm"
            >
              <option value="1024">1024px (Fast)</option>
              <option value="2048">2048px (Balanced)</option>
              <option value="4096">4096px (High Quality)</option>
            </select>
          </div>
          
          {/* PBR */}
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={enablePBR}
              onChange={(e) => setEnablePBR(e.target.checked)}
              className="rounded"
            />
            <span className="text-sm">Generate PBR maps (metallic, roughness, normal)</span>
          </label>
          
          {/* Reference Image */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">Reference Image URL (optional)</label>
            <input
              type="url"
              value={imagePrompt}
              onChange={(e) => setImagePrompt(e.target.value)}
              placeholder="https://example.com/reference.jpg"
              className="w-full p-2 bg-gray-800 border border-gray-600 rounded text-sm"
            />
          </div>
        </div>
      </details>
      
      {/* Progress Display */}
      {progress && (
        <div className="mb-4 p-3 bg-gray-800 rounded">
          {/* Pipeline stage indicator for segmented mode */}
          {pipelineStage && retextureMode === 'segmented' && (
            <div className="flex items-center gap-2 mb-2 text-xs text-blue-400">
              <span className="inline-block w-2 h-2 bg-blue-400 rounded-full animate-pulse" />
              <span className="font-medium">{pipelineStage}</span>
            </div>
          )}
          <div className="text-sm mb-2">{progress}</div>
          {progressPercent > 0 && progressPercent < 100 && (
            <div className="w-full h-2 bg-gray-700 rounded overflow-hidden">
              <div
                className={`h-full transition-all duration-300 ${
                  retextureMode === 'segmented' ? 'bg-green-500' : 'bg-blue-500'
                }`}
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          )}
          {/* Stage breakdown for segmented mode */}
          {retextureMode === 'segmented' && isProcessing && (
            <div className="mt-2 flex gap-1">
              {['Segment', 'Texture', 'Apply', 'Complete'].map((stage, idx) => {
                const stagePercent = [0, 25, 50, 75][idx];
                const isActive = progressPercent >= stagePercent && progressPercent < (stagePercent + 25);
                const isComplete = progressPercent > stagePercent + 20;
                return (
                  <div
                    key={stage}
                    className={`flex-1 text-center text-xs py-1 rounded ${
                      isActive ? 'bg-green-600 text-white' :
                      isComplete ? 'bg-green-800 text-green-300' :
                      'bg-gray-700 text-gray-500'
                    }`}
                  >
                    {stage}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
      
      {/* Error Display */}
      {error && (
        <div className="mb-4 p-3 bg-red-900/50 border border-red-600 rounded text-red-300 text-sm">
          ❌ {error}
        </div>
      )}
      
      {/* Action Buttons */}
      <div className="flex gap-2">
        {isProcessing ? (
          <button
            onClick={handleCancelTask}
            className="flex-1 py-3 bg-red-600 hover:bg-red-500 rounded font-medium transition-colors"
          >
            Cancel
          </button>
        ) : (
          <button
            onClick={handleStartRetexture}
            disabled={!meshUrl || (!customPrompt && !selectedPreset)}
            className={`flex-1 py-3 rounded font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
              retextureMode === 'segmented'
                ? 'bg-gradient-to-r from-green-600 to-teal-600 hover:from-green-500 hover:to-teal-500'
                : 'bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500'
            }`}
          >
            {retextureMode === 'segmented' 
              ? `🎯 Retexture ${activeCategory.charAt(0).toUpperCase() + activeCategory.slice(1)} Only`
              : '🎨 Apply AI Texture (Full Model)'}
          </button>
        )}
      </div>
      
      {/* Info */}
      <p className="text-xs text-gray-500 mt-4 text-center">
        {retextureMode === 'segmented'
          ? 'Powered by Gemini AI + Meshy • Segmented retexturing typically takes 2-4 minutes'
          : 'Powered by Meshy AI • Retexturing typically takes 1-3 minutes'}
      </p>
    </div>
  );
};

export default MeshyRetexturePanel;
