/**
 * Segmented Retexture Service
 * 
 * Orchestrates the full segmented retexturing pipeline:
 * 1. Segment mesh (Trimesh/AI) → Extract floor/walls/countertops as separate OBJ
 * 2. Generate texture (Gemini) → Create seamless tileable texture
 * 3. Retexture segment (Meshy) → Apply texture to the isolated segment
 * 4. Reassemble (Three.js) → Load both parts in scene, auto-aligned by world coordinates
 */

// ============================================================================
// Types
// ============================================================================

export interface SegmentInfo {
  type: 'floor' | 'walls' | 'ceiling' | 'countertops';
  path: string;
  url: string;
  filename: string;
  faceCount: number;
  vertexCount: number;
  bounds?: {
    min: [number, number, number];
    max: [number, number, number];
  };
}

export interface SegmentationResult {
  success: boolean;
  jobId: string;
  meshUrl: string;
  surfaceType: string;
  segments: Record<string, SegmentInfo>;
  remainder: SegmentInfo | null;
  bounds?: {
    min: [number, number, number];
    max: [number, number, number];
    height: number;
  };
  totalFaces: number;
  totalVertices: number;
  error?: string;
}

export interface TextureGenerationResult {
  success: boolean;
  textureId: string;
  textureUrl: string;
  textureDataUrl: string;
  surfaceType: string;
  materialOption: string;
  tileSize: { width: number; height: number };
  description?: string;
  error?: string;
}

export interface RetextureTaskResult {
  success: boolean;
  taskId: string;
  jobId: string;
  surfaceType: string;
  isSegment: boolean;
  error?: string;
}

export interface RetextureStatus {
  success: boolean;
  jobId: string;
  taskId: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'EXPIRED';
  progress: number;
  modelUrls?: {
    glb?: string;
    fbx?: string;
    obj?: string;
    usdz?: string;
  };
  thumbnailUrl?: string;
  error?: string;
}

export interface SegmentedRetextureResult {
  success: boolean;
  // Original mesh parts for reassembly
  remainderUrl: string | null;
  // Retextured segment
  retexturedSegmentUrl: string;
  retexturedThumbnailUrl?: string;
  // Metadata
  surfaceType: string;
  textureUrl: string;
  processingTime: number;
  error?: string;
}

export interface PipelineProgress {
  stage: 'segmenting' | 'generating-texture' | 'retexturing' | 'downloading' | 'complete' | 'error';
  progress: number; // 0-100
  message: string;
  details?: string;
}

// ============================================================================
// API Functions
// ============================================================================

/**
 * Step 1: Segment mesh by surface type using Trimesh
 */
export async function segmentMeshBySurface(
  meshUrl: string,
  surfaceType: 'floor' | 'walls' | 'ceiling' | 'countertops' | 'all'
): Promise<SegmentationResult> {
  console.log('[SegmentedRetexture] Segmenting mesh:', meshUrl, 'Surface:', surfaceType);
  
  const response = await fetch('/api/mesh/segment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ meshUrl, surfaceType }),
  });
  
  const result = await response.json();
  
  if (!result.success) {
    console.error('[SegmentedRetexture] Segmentation failed:', result.error);
  }
  
  return result;
}

/**
 * Step 1b: AI-powered segmentation for specific objects
 */
export async function segmentMeshWithAI(
  meshUrl: string,
  targetObject: string,
  useHybrid: boolean = true
): Promise<SegmentationResult & { aiAnalysis?: string; aiConfidence?: number }> {
  console.log('[SegmentedRetexture] AI Segmentation for:', targetObject);
  
  const response = await fetch('/api/mesh/segment-ai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ meshUrl, targetObject, useHybrid }),
  });
  
  return response.json();
}

/**
 * Step 2: Generate seamless texture with Gemini Nano Banana Pro
 * Now accepts viewport screenshot for context-aware texture generation
 */
export async function generateSeamlessTexture(
  surfaceType: 'flooring' | 'walls' | 'countertops',
  materialOption: string,
  customPrompt?: string,
  tileSize: { width: number; height: number } = { width: 1, height: 1 },
  viewportImage?: string // Base64 image of user's current top-down view
): Promise<TextureGenerationResult> {
  console.log('[SegmentedRetexture] Generating texture:', surfaceType, materialOption);
  console.log('[SegmentedRetexture] Viewport context:', !!viewportImage);
  
  const response = await fetch('/api/seamless-textures/generate-seamless', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      surfaceType,
      materialOption,
      customPrompt,
      tileSize,
      viewportImage, // Send screenshot for context-aware generation
    }),
  });
  
  return response.json();
}

/**
 * Step 3: Create Meshy retexture task for the segment
 */
export async function retextureSegment(
  segmentMeshUrl: string,
  textureUrl: string,
  surfaceType: string,
  options: {
    textPrompt?: string;
    enableOriginalUV?: boolean;
    resolution?: '1024' | '2048' | '4096';
  } = {}
): Promise<RetextureTaskResult> {
  console.log('[SegmentedRetexture] Retexturing segment:', segmentMeshUrl);
  
  const response = await fetch('/api/meshy/retexture-segment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      segmentMeshUrl,
      textureUrl,
      surfaceType,
      textPrompt: options.textPrompt,
      enableOriginalUV: options.enableOriginalUV ?? true,
      resolution: options.resolution ?? '2048',
    }),
  });
  
  return response.json();
}

/**
 * Poll for retexture status
 */
export async function getRetextureStatus(jobId: string): Promise<RetextureStatus> {
  const response = await fetch(`/api/meshy/status/${jobId}`);
  return response.json();
}

/**
 * Download completed retextured model
 */
export async function downloadRetexturedModel(
  jobId: string,
  format: 'glb' | 'obj' = 'glb'
): Promise<{ success: boolean; localUrl?: string; error?: string }> {
  const response = await fetch(`/api/meshy/download/${jobId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ format }),
  });
  
  return response.json();
}

/**
 * Get available texture presets
 */
export async function getTexturePresets(): Promise<{
  success: boolean;
  presets: Record<string, Array<{ key: string; name: string; description: string }>>;
}> {
  const response = await fetch('/api/seamless-textures/presets');
  return response.json();
}

// ============================================================================
// Full Pipeline Orchestration
// ============================================================================

/**
 * Run the complete segmented retexturing pipeline
 * 
 * @param meshUrl - URL of the original mesh
 * @param surfaceType - Which surface to retexture
 * @param materialOption - Material preset key (e.g., 'oak-hardwood')
 * @param onProgress - Callback for progress updates
 * @param customPrompt - Optional custom texture description
 * @param viewportImage - Optional base64 screenshot of user's top-down view for context-aware generation
 */
export async function runSegmentedRetexturePipeline(
  meshUrl: string,
  surfaceType: 'floor' | 'walls' | 'ceiling' | 'countertops',
  materialOption: string,
  onProgress?: (progress: PipelineProgress) => void,
  customPrompt?: string,
  viewportImage?: string
): Promise<SegmentedRetextureResult> {
  const startTime = Date.now();
  
  try {
    // ========================================================================
    // STEP 1: Segment the mesh
    // ========================================================================
    onProgress?.({
      stage: 'segmenting',
      progress: 5,
      message: `Extracting ${surfaceType} from mesh...`,
      details: 'Using Trimesh geometric analysis',
    });
    
    const segmentResult = await segmentMeshBySurface(meshUrl, surfaceType);
    
    if (!segmentResult.success) {
      throw new Error(segmentResult.error || 'Failed to segment mesh');
    }
    
    const segment = segmentResult.segments[surfaceType];
    if (!segment) {
      throw new Error(`No ${surfaceType} segment found in mesh`);
    }
    
    console.log('[SegmentedRetexture] Segment extracted:', segment.url);
    
    onProgress?.({
      stage: 'segmenting',
      progress: 20,
      message: `${surfaceType} extracted (${segment.faceCount} faces)`,
      details: `Remainder saved with ${segmentResult.remainder?.faceCount || 0} faces`,
    });
    
    // ========================================================================
    // STEP 2: Generate seamless texture with Gemini
    // ========================================================================
    onProgress?.({
      stage: 'generating-texture',
      progress: 25,
      message: viewportImage 
        ? 'Analyzing your room and generating context-aware texture...'
        : 'Generating seamless texture with AI...',
      details: `Material: ${materialOption}`,
    });
    
    // Map surface type to API format
    const textureSurfaceType = surfaceType === 'floor' ? 'flooring' : 
                               surfaceType === 'countertops' ? 'countertops' : 
                               'walls';
    
    const textureResult = await generateSeamlessTexture(
      textureSurfaceType,
      materialOption,
      customPrompt,
      { width: 1, height: 1 }, // Default tile size
      viewportImage // Pass viewport screenshot for context-aware generation
    );
    
    if (!textureResult.success) {
      throw new Error(textureResult.error || 'Failed to generate texture');
    }
    
    console.log('[SegmentedRetexture] Texture generated:', textureResult.textureUrl);
    
    onProgress?.({
      stage: 'generating-texture',
      progress: 45,
      message: 'Seamless texture generated!',
      details: textureResult.description,
    });
    
    // ========================================================================
    // STEP 3: Send segment + texture to Meshy for retexturing
    // ========================================================================
    onProgress?.({
      stage: 'retexturing',
      progress: 50,
      message: 'Sending to Meshy for 3D texture application...',
      details: 'This typically takes 1-3 minutes',
    });
    
    const retextureResult = await retextureSegment(
      segment.url,
      textureResult.textureUrl,
      surfaceType
    );
    
    if (!retextureResult.success) {
      throw new Error(retextureResult.error || 'Failed to create retexture task');
    }
    
    console.log('[SegmentedRetexture] Retexture task created:', retextureResult.jobId);
    
    // Poll for completion
    const maxWaitTime = 5 * 60 * 1000; // 5 minutes
    const pollInterval = 5000; // 5 seconds
    const taskStartTime = Date.now();
    
    while (Date.now() - taskStartTime < maxWaitTime) {
      const status = await getRetextureStatus(retextureResult.jobId);
      
      const elapsedSeconds = Math.floor((Date.now() - taskStartTime) / 1000);
      
      onProgress?.({
        stage: 'retexturing',
        progress: 50 + Math.min(status.progress * 0.35, 35),
        message: `Meshy processing: ${status.status}`,
        details: `${status.progress}% complete (${elapsedSeconds}s elapsed)`,
      });
      
      if (status.status === 'SUCCEEDED') {
        break;
      }
      
      if (status.status === 'FAILED') {
        throw new Error(status.error || 'Meshy retexturing failed');
      }
      
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
    
    // ========================================================================
    // STEP 4: Download the retextured model
    // ========================================================================
    onProgress?.({
      stage: 'downloading',
      progress: 90,
      message: 'Downloading retextured model...',
    });
    
    const downloadResult = await downloadRetexturedModel(retextureResult.jobId, 'glb');
    
    if (!downloadResult.success) {
      throw new Error(downloadResult.error || 'Failed to download retextured model');
    }
    
    const processingTime = Date.now() - startTime;
    
    onProgress?.({
      stage: 'complete',
      progress: 100,
      message: '✅ Retexturing complete!',
      details: `Processed in ${Math.round(processingTime / 1000)}s`,
    });
    
    return {
      success: true,
      remainderUrl: segmentResult.remainder?.url || null,
      retexturedSegmentUrl: downloadResult.localUrl!,
      surfaceType,
      textureUrl: textureResult.textureUrl,
      processingTime,
    };
    
  } catch (error: any) {
    console.error('[SegmentedRetexture] Pipeline error:', error);
    
    onProgress?.({
      stage: 'error',
      progress: 0,
      message: 'Retexturing failed',
      details: error.message,
    });
    
    return {
      success: false,
      remainderUrl: null,
      retexturedSegmentUrl: '',
      surfaceType,
      textureUrl: '',
      processingTime: Date.now() - startTime,
      error: error.message,
    };
  }
}

// ============================================================================
// Utility: Load segmented parts into Three.js scene
// ============================================================================

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';

/**
 * Load the retextured segment and remainder into a Three.js scene.
 * They will automatically align because they share world coordinates.
 */
export async function loadSegmentedMeshIntoScene(
  scene: THREE.Scene,
  remainderUrl: string | null,
  retexturedSegmentUrl: string,
  onLoad?: (parts: { remainder?: THREE.Object3D; segment: THREE.Object3D }) => void
): Promise<{ remainder?: THREE.Object3D; segment: THREE.Object3D }> {
  const gltfLoader = new GLTFLoader();
  const objLoader = new OBJLoader();
  
  const parts: { remainder?: THREE.Object3D; segment: THREE.Object3D } = {
    segment: new THREE.Object3D(),
  };
  
  // Load retextured segment (usually GLB from Meshy)
  const segmentExt = retexturedSegmentUrl.split('.').pop()?.toLowerCase();
  
  console.log('[SegmentedRetexture] Loading retextured segment:', retexturedSegmentUrl);
  
  if (segmentExt === 'glb' || segmentExt === 'gltf') {
    const gltf = await new Promise<any>((resolve, reject) => {
      gltfLoader.load(retexturedSegmentUrl, resolve, undefined, reject);
    });
    parts.segment = gltf.scene;
    
    // Ensure materials are visible and textures are loaded
    parts.segment.traverse((child: any) => {
      if (child.isMesh) {
        if (child.material) {
          child.material.needsUpdate = true;
          
          // Force texture update if present
          if (child.material.map) {
            child.material.map.needsUpdate = true;
            console.log('[SegmentedRetexture] Segment has texture map:', child.material.map);
          } else {
            console.warn('[SegmentedRetexture] Segment material has NO texture map!');
          }
          
          // If it's a MeshBasicMaterial, convert to MeshStandardMaterial for better lighting
          if (child.material.type === 'MeshBasicMaterial' && child.material.map) {
            const oldMaterial = child.material;
            child.material = new THREE.MeshStandardMaterial({
              map: oldMaterial.map,
              color: oldMaterial.color,
              transparent: oldMaterial.transparent,
              opacity: oldMaterial.opacity,
              side: oldMaterial.side,
            });
            console.log('[SegmentedRetexture] Converted MeshBasicMaterial to MeshStandardMaterial');
          }
          
          console.log('[SegmentedRetexture] Segment mesh material:', child.material.type);
        } else {
          console.warn('[SegmentedRetexture] Segment mesh has NO material!');
        }
      }
    });
  } else {
    parts.segment = await new Promise<THREE.Object3D>((resolve, reject) => {
      objLoader.load(retexturedSegmentUrl, resolve, undefined, reject);
    });
  }
  
  parts.segment.name = 'retextured-segment';
  
  // Debug: Log segment bounds and position
  const segmentBox = new THREE.Box3().setFromObject(parts.segment);
  console.log('[SegmentedRetexture] Segment bounds:', {
    min: segmentBox.min.toArray().map(v => v.toFixed(2)),
    max: segmentBox.max.toArray().map(v => v.toFixed(2)),
  });
  
  // Slight offset to avoid z-fighting with original mesh
  parts.segment.position.y += 0.001;
  
  scene.add(parts.segment);
  
  console.log('[SegmentedRetexture] Retextured segment loaded into scene');
  
  // Load remainder if available
  if (remainderUrl) {
    const remainderExt = remainderUrl.split('.').pop()?.toLowerCase();
    
    console.log('[SegmentedRetexture] Loading remainder:', remainderUrl);
    
    if (remainderExt === 'glb' || remainderExt === 'gltf') {
      const gltf = await new Promise<any>((resolve, reject) => {
        gltfLoader.load(remainderUrl, resolve, undefined, reject);
      });
      parts.remainder = gltf.scene;
    } else {
      parts.remainder = await new Promise<THREE.Object3D>((resolve, reject) => {
        objLoader.load(remainderUrl, resolve, undefined, reject);
      });
      
      // OBJ has no texture - apply a basic material
      parts.remainder.traverse((child: any) => {
        if (child.isMesh && !child.material) {
          child.material = new THREE.MeshStandardMaterial({
            color: 0xcccccc,
            roughness: 0.8,
          });
          console.log('[SegmentedRetexture] Applied default material to remainder');
        }
      });
    }
    
    if (parts.remainder) {
      parts.remainder.name = 'mesh-remainder';
      scene.add(parts.remainder);
    }
  }
  
  console.log('[SegmentedRetexture] Parts loaded into scene:', {
    segment: parts.segment.name,
    remainder: parts.remainder?.name,
  });
  
  onLoad?.(parts);
  
  return parts;
}
