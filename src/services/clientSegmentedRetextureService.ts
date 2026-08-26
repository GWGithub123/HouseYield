/**
 * Client-Side Segmented Retexture Pipeline
 * 
 * Uses existing mesh segmentation from PhotogrammetryViewer
 * instead of calling Python backend segmentation
 */

import * as THREE from 'three';
import type { MeshSegmentation } from './meshSegmentationService';
import type { PipelineProgress, SegmentedRetextureResult } from './segmentedRetextureService';
import {
  generateSeamlessTexture,
  retextureSegment,
  getRetextureStatus,
  downloadRetexturedModel,
} from './segmentedRetextureService';
import {
  exportSegmentToOBJ,
  exportRemainderToOBJ,
  uploadOBJToServer,
} from './meshExportService';

/**
 * Run segmented retexture using client-side segmentation
 */
export async function runClientSegmentedRetexture(
  mesh: THREE.Mesh | THREE.Group,
  segmentation: MeshSegmentation,
  surfaceType: 'floor' | 'walls' | 'ceiling' | 'countertops',
  materialOption: string,
  onProgress?: (progress: PipelineProgress) => void,
  customPrompt?: string,
  viewportImage?: string
): Promise<SegmentedRetextureResult> {
  const startTime = Date.now();
  
  try {
    // Get the first mesh (handle Groups)
    let targetMesh: THREE.Mesh | null = null;
    if (mesh instanceof THREE.Mesh) {
      targetMesh = mesh;
    } else {
      mesh.traverse((child) => {
        if (child instanceof THREE.Mesh && !targetMesh) {
          targetMesh = child;
        }
      });
    }
    
    if (!targetMesh) {
      throw new Error('No mesh found in object');
    }
    
    // ========================================================================
    // STEP 1: Export segment using existing segmentation
    // ========================================================================
    onProgress?.({
      stage: 'segmenting',
      progress: 5,
      message: `Exporting ${surfaceType} segment...`,
      details: 'Using pre-computed segmentation',
    });
    
    // Get the appropriate segment
    const surfaceMap = {
      'floor': segmentation.floors,
      'walls': segmentation.walls,
      'ceiling': segmentation.ceilings,
      'countertops': segmentation.counters,
    };
    
    const segments = surfaceMap[surfaceType];
    if (!segments || segments.length === 0) {
      throw new Error(`No ${surfaceType} found in segmentation`);
    }
    
    // Use the largest segment (main floor/wall/etc.)
    const segment = segments.reduce((prev, current) =>
      current.area > prev.area ? current : prev
    );
    
    console.log(`[ClientRetexture] Exporting ${surfaceType}:`, {
      faces: segment.faceIndices.length,
      area: segment.area
    });
    
    onProgress?.({
      stage: 'segmenting',
      progress: 10,
      message: 'Converting segment to OBJ format...',
    });
    
    // Export segment and remainder as OBJ
    const segmentOBJ = exportSegmentToOBJ(targetMesh, segment);
    const remainderOBJ = exportRemainderToOBJ(targetMesh, segment.faceIndices);
    
    onProgress?.({
      stage: 'segmenting',
      progress: 15,
      message: 'Uploading segments to server...',
    });
    
    // Upload both OBJs
    const [segmentUpload, remainderUpload] = await Promise.all([
      uploadOBJToServer(segmentOBJ, `${surfaceType}_segment.obj`),
      uploadOBJToServer(remainderOBJ, 'remainder.obj'),
    ]);
    
    if (!segmentUpload.success || !remainderUpload.success) {
      throw new Error('Failed to upload segment files');
    }
    
    console.log('[ClientRetexture] Segments uploaded:', {
      segment: segmentUpload.url,
      remainder: remainderUpload.url
    });
    
    onProgress?.({
      stage: 'segmenting',
      progress: 20,
      message: `${surfaceType} extracted (${segment.faceIndices.length} faces)`,
      details: `Remainder saved`,
    });
    
    // ========================================================================
    // STEP 2: Generate texture with Gemini
    // ========================================================================
    onProgress?.({
      stage: 'generating-texture',
      progress: 25,
      message: viewportImage 
        ? 'Analyzing your room and generating context-aware texture...'
        : 'Generating seamless texture with AI...',
      details: `Material: ${materialOption}`,
    });
    
    const textureSurfaceType = surfaceType === 'floor' ? 'flooring' : 
                               surfaceType === 'countertops' ? 'countertops' : 
                               'walls';
    
    const textureResult = await generateSeamlessTexture(
      textureSurfaceType,
      materialOption,
      customPrompt,
      { width: 1, height: 1 },
      viewportImage
    );
    
    if (!textureResult.success) {
      throw new Error(textureResult.error || 'Failed to generate texture');
    }
    
    console.log('[ClientRetexture] Texture generated:', textureResult.textureUrl);
    
    onProgress?.({
      stage: 'generating-texture',
      progress: 45,
      message: 'Seamless texture generated!',
      details: textureResult.description,
    });
    
    // ========================================================================
    // STEP 3: Retexture with Meshy
    // ========================================================================
    onProgress?.({
      stage: 'retexturing',
      progress: 50,
      message: 'Sending to Meshy for 3D texture application...',
      details: 'This typically takes 1-3 minutes',
    });
    
    const retextureResult = await retextureSegment(
      segmentUpload.url!,
      textureResult.textureUrl,
      surfaceType
    );
    
    if (!retextureResult.success) {
      throw new Error(retextureResult.error || 'Failed to create retexture task');
    }
    
    console.log('[ClientRetexture] Retexture task created:', retextureResult.jobId);
    
    // Poll for completion
    const maxWaitTime = 5 * 60 * 1000;
    const pollInterval = 5000;
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
    // STEP 4: Download
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
      remainderUrl: remainderUpload.url!,
      retexturedSegmentUrl: downloadResult.localUrl!,
      surfaceType,
      textureUrl: textureResult.textureUrl,
      processingTime,
    };
    
  } catch (error: any) {
    console.error('[ClientRetexture] Pipeline error:', error);
    
    onProgress?.({
      stage: 'error',
      progress: 0,
      message: `Error: ${error.message}`,
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
