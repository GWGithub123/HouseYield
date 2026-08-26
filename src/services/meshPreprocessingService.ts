/**
 * Mesh Preprocessing Service
 * 
 * Frontend service for preparing photogrammetry scans before Meshy AI retexturing.
 * 
 * This solves the "blue model" problem where Meshy fails on photogrammetry scans due to:
 * - Inverted normals (faces pointing wrong direction)
 * - Broken geometry (holes, degenerate triangles)
 * - Over-detailed meshes (millions of triangles)
 * 
 * Flow:
 * 1. analyzeMesh() - Check mesh health, determine if repair is needed
 * 2. preprocessMesh() - Apply repairs and decimation
 * 3. Use the preprocessed mesh URL with Meshy API
 */

const API_BASE = '/api/mesh/preprocess';

// ============================================================================
// Types
// ============================================================================

export interface MeshAnalysis {
  is_watertight: boolean;
  is_winding_consistent: boolean;
  face_count: number;
  vertex_count: number;
  has_degenerate_faces: boolean;
  degenerate_count: number;
  bounding_box: {
    min: [number, number, number];
    max: [number, number, number];
    dimensions: [number, number, number];
  };
  estimated_scale: string;
  max_dimension: number;
}

export interface AnalyzeResult {
  success: boolean;
  analysis: MeshAnalysis;
  needsRepair: boolean;
  repairRecommendations: string[];
  error?: string;
}

export interface PreprocessResult {
  success: boolean;
  preprocessedUrl: string;
  jobId: string;
  originalMeshUrl: string;
  originalAnalysis: MeshAnalysis;
  finalAnalysis: MeshAnalysis;
  repairs: {
    normals_fixed: boolean;
    degenerate_faces_removed: number;
    decimation: {
      original_faces: number;
      final_faces: number;
      reduction_percent: number;
      skipped: boolean;
    };
    holes_filled: boolean;
    // New professional preprocessing fields
    disconnected_components_removed?: number;
    floor_aligned?: boolean;
    skirt_faces_clipped?: number;
  };
  processingTimeMs: number;
  error?: string;
}

export interface AutoPreprocessResult {
  success: boolean;
  meshUrl: string;
  wasPreprocessed: boolean;
  originalMeshUrl?: string;
  originalAnalysis?: MeshAnalysis;
  finalAnalysis?: MeshAnalysis;
  repairs?: PreprocessResult['repairs'];
  processingTimeMs?: number;
  message?: string;
  error?: string;
}

export interface PreprocessOptions {
  targetFaces?: number;
  decimationRatio?: number;
  skipDecimation?: boolean;
  skipHoleFill?: boolean;
  aggressive?: boolean;
}

export interface ServiceStatus {
  success: boolean;
  available: boolean;
  pythonAvailable?: boolean;
  trimeshAvailable?: boolean;
  error?: string;
}

// ============================================================================
// API Functions
// ============================================================================

/**
 * Analyze mesh health without modifying it.
 * 
 * Returns diagnostic info about the mesh including:
 * - Whether normals are consistent (critical for Meshy)
 * - Face/vertex count
 * - Whether holes exist
 * - Recommendations for repairs
 */
export async function analyzeMesh(meshUrl: string): Promise<AnalyzeResult> {
  const response = await fetch(`${API_BASE}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ meshUrl }),
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || `Analysis failed: ${response.status}`);
  }
  
  return response.json();
}

/**
 * Preprocess a mesh for Meshy AI retexturing.
 * 
 * Applies the following repairs:
 * 1. Fix normals (solve "blue model" problem)
 * 2. Remove degenerate geometry
 * 3. Decimate to target face count
 * 4. Fill holes
 * 
 * Returns URL to the cleaned mesh.
 */
export async function preprocessMesh(
  meshUrl: string,
  options: PreprocessOptions = {}
): Promise<PreprocessResult> {
  const response = await fetch(`${API_BASE}/repair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      meshUrl,
      ...options,
    }),
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || `Preprocessing failed: ${response.status}`);
  }
  
  return response.json();
}

/**
 * Smart auto-preprocessing: analyze first, repair only if needed.
 * 
 * This is the recommended function to use before sending to Meshy.
 * It will:
 * 1. Analyze the mesh
 * 2. Only apply repairs if they're actually needed
 * 3. Return either the original URL (if healthy) or preprocessed URL
 * 
 * Example:
 * ```ts
 * const result = await autoPreprocessMesh(meshUrl);
 * // Use result.meshUrl for Meshy API - it's either original or preprocessed
 * sendToMeshy(result.meshUrl, textPrompt);
 * ```
 */
export async function autoPreprocessMesh(
  meshUrl: string,
  options: { forceRepair?: boolean; targetFaces?: number } = {}
): Promise<AutoPreprocessResult> {
  const response = await fetch(`${API_BASE}/auto`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      meshUrl,
      ...options,
    }),
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || `Auto-preprocessing failed: ${response.status}`);
  }
  
  return response.json();
}

/**
 * Check if the preprocessing service is available.
 * 
 * Verifies:
 * - Python is installed
 * - Trimesh library is available
 * - Preprocessing script exists
 */
export async function checkPreprocessingService(): Promise<ServiceStatus> {
  const response = await fetch(`${API_BASE}/status`);
  
  if (!response.ok) {
    return {
      success: false,
      available: false,
      error: 'Service check failed',
    };
  }
  
  return response.json();
}

/**
 * Clean up old preprocessed files.
 * Call periodically to free up disk space.
 */
export async function cleanupPreprocessedFiles(): Promise<{ success: boolean; deletedCount: number }> {
  const response = await fetch(`${API_BASE}/cleanup`, {
    method: 'DELETE',
  });
  
  return response.json();
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get a human-readable summary of mesh analysis.
 */
export function getAnalysisSummary(analysis: MeshAnalysis): string {
  const issues: string[] = [];
  
  if (!analysis.is_winding_consistent) {
    issues.push('⚠️ Normals inconsistent (may cause "blue model" error)');
  }
  
  if (analysis.degenerate_count > 0) {
    issues.push(`⚠️ ${analysis.degenerate_count} degenerate faces`);
  }
  
  if (analysis.face_count > 100000) {
    issues.push(`⚠️ High poly count (${analysis.face_count.toLocaleString()} faces)`);
  }
  
  if (!analysis.is_watertight) {
    issues.push('ℹ️ Mesh has holes (may cause texture bleeding)');
  }
  
  if (issues.length === 0) {
    return '✅ Mesh is healthy and ready for Meshy AI';
  }
  
  return issues.join('\n');
}

/**
 * Get a human-readable summary of preprocessing results.
 */
export function getRepairSummary(result: PreprocessResult): string {
  const repairs: string[] = [];
  
  if (result.repairs.normals_fixed) {
    repairs.push('✅ Fixed normals');
  }
  
  if (result.repairs.degenerate_faces_removed > 0) {
    repairs.push(`✅ Removed ${result.repairs.degenerate_faces_removed} degenerate faces`);
  }
  
  if (!result.repairs.decimation.skipped) {
    const reduction = result.repairs.decimation.reduction_percent;
    repairs.push(
      `✅ Decimated ${reduction.toFixed(1)}% (${result.repairs.decimation.original_faces.toLocaleString()} → ${result.repairs.decimation.final_faces.toLocaleString()} faces)`
    );
  }
  
  if (result.repairs.holes_filled) {
    repairs.push('✅ Filled holes');
  }
  
  if (repairs.length === 0) {
    return 'No repairs were needed.';
  }
  
  return repairs.join('\n') + `\n⏱️ Processed in ${result.processingTimeMs.toFixed(0)}ms`;
}

/**
 * Determine if a mesh should be preprocessed based on analysis.
 */
export function shouldPreprocess(analysis: MeshAnalysis): boolean {
  // Critical issues that will cause Meshy to fail
  if (!analysis.is_winding_consistent) {
    return true;
  }
  
  // Degenerate faces can cause issues
  if (analysis.degenerate_count > 100) {
    return true;
  }
  
  // High poly count slows down Meshy and may cause timeouts
  if (analysis.face_count > 150000) {
    return true;
  }
  
  return false;
}

// =============================================================================
// FLOOR SEGMENTATION API
// =============================================================================

export interface FloorSegmentationResult {
  success: boolean;
  jobId: string;
  floorUrl: string;       // Send this to Meshy for retexturing
  shellUrl: string;       // Original room walls/ceiling
  floorInfo: {
    floor_faces: number;
    shell_faces: number;
    floor_level: number;
    floor_percent: number;
    floor_bounds?: {
      min: number[];
      max: number[];
    };
  };
  originalFaces: number;
  processingTimeMs: number;
  error?: string;
}

export interface StitchResult {
  success: boolean;
  jobId: string;
  combinedUrl: string;    // Final renovated room
  shellFaces: number;
  floorFaces: number;
  totalFaces: number;
  processingTimeMs: number;
  error?: string;
}

/**
 * Segment the floor from a room scan.
 * 
 * This is the PREFERRED method for floor retexturing:
 * 1. Extracts just the floor as a separate mesh
 * 2. Meshy only textures the floor (no blue model issues!)
 * 3. Stitch the textured floor back with original walls
 * 
 * @param meshUrl - URL to the room scan mesh
 * @param angleToleranceDegrees - Max degrees from vertical for floor detection (default 15)
 */
export async function segmentFloor(
  meshUrl: string,
  angleToleranceDegrees: number = 15
): Promise<FloorSegmentationResult> {
  console.log('[FloorSegmentation] Segmenting floor from:', meshUrl);
  
  const response = await fetch('/api/mesh/preprocess/segment-floor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      meshUrl,
      angleToleranceDegrees,
    }),
  });
  
  const result = await response.json();
  
  if (!result.success) {
    console.error('[FloorSegmentation] Failed:', result.error);
    throw new Error(result.error || 'Floor segmentation failed');
  }
  
  console.log('[FloorSegmentation] ✅ Success');
  console.log('[FloorSegmentation] Floor:', result.floorUrl, `(${result.floorInfo.floor_faces} faces)`);
  console.log('[FloorSegmentation] Shell:', result.shellUrl, `(${result.floorInfo.shell_faces} faces)`);
  
  return result;
}

/**
 * Stitch a textured floor (from Meshy) back into the original room shell.
 * 
 * @param shellUrl - URL to room shell from segmentFloor()
 * @param texturedFloorUrl - URL to AI-textured floor from Meshy
 */
export async function stitchFloor(
  shellUrl: string,
  texturedFloorUrl: string
): Promise<StitchResult> {
  console.log('[FloorStitch] Stitching floor back into room');
  console.log('[FloorStitch] Shell:', shellUrl);
  console.log('[FloorStitch] Textured floor:', texturedFloorUrl);
  
  const response = await fetch('/api/mesh/preprocess/stitch-floor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      shellUrl,
      texturedFloorUrl,
    }),
  });
  
  const result = await response.json();
  
  if (!result.success) {
    console.error('[FloorStitch] Failed:', result.error);
    throw new Error(result.error || 'Floor stitching failed');
  }
  
  console.log('[FloorStitch] ✅ Success:', result.combinedUrl);
  console.log('[FloorStitch] Total faces:', result.totalFaces);
  
  return result;
}

/**
 * Complete floor retexturing pipeline:
 * 1. Segment floor from room
 * 2. Send floor to Meshy for retexturing
 * 3. Stitch textured floor back with room shell
 * 
 * This is the recommended workflow for floor renovations.
 * 
 * @param meshUrl - Original room scan URL
 * @param texturePrompt - What flooring to apply (e.g., "oak hardwood planks")
 * @param onProgress - Progress callback
 */
export async function retextureFloorPipeline(
  meshUrl: string,
  texturePrompt: string,
  referenceImageUrl?: string,
  onProgress?: (stage: string, percent: number) => void
): Promise<{
  success: boolean;
  finalMeshUrl: string;
  floorUrl: string;
  shellUrl: string;
  texturedFloorUrl: string;
  error?: string;
}> {
  try {
    // Stage 1: Segment floor
    onProgress?.('Segmenting floor from room...', 10);
    const segmentResult = await segmentFloor(meshUrl);
    
    if (!segmentResult.success) {
      throw new Error(segmentResult.error || 'Floor segmentation failed');
    }
    
    onProgress?.('Floor extracted, sending to Meshy AI...', 30);
    
    // Stage 2: Send floor to Meshy
    // Import the Meshy function
    const { createMeshyRetextureTask, pollMeshyRetextureUntilDone, downloadMeshyModel } = await import('./meshEditingService');
    
    const meshyTask = await createMeshyRetextureTask(
      segmentResult.floorUrl,
      texturePrompt,
      {
        negativePrompt: 'walls, ceiling, furniture, room, perspective, distortion',
        resolution: '2048',
        imagePrompt: referenceImageUrl,
      }
    );
    
    if (!meshyTask.success || !meshyTask.jobId) {
      throw new Error(meshyTask.error || 'Failed to create Meshy task');
    }
    
    onProgress?.('Meshy processing floor texture...', 50);
    
    // Poll until complete
    const finalStatus = await pollMeshyRetextureUntilDone(meshyTask.jobId, (status) => {
      const percent = 50 + (status.progress || 0) * 0.3; // 50-80%
      onProgress?.(`Meshy: ${status.status}`, percent);
    });
    
    if (finalStatus.status !== 'SUCCEEDED') {
      throw new Error(`Meshy failed: ${finalStatus.status}`);
    }
    
    // Download textured floor
    onProgress?.('Downloading textured floor...', 85);
    const downloadResult = await downloadMeshyModel(meshyTask.jobId, 'glb');
    
    if (!downloadResult.success || !downloadResult.localUrl) {
      throw new Error('Failed to download textured floor from Meshy');
    }
    
    // Stage 3: Stitch back
    onProgress?.('Stitching textured floor back into room...', 95);
    const stitchResult = await stitchFloor(segmentResult.shellUrl, downloadResult.localUrl);
    
    if (!stitchResult.success) {
      throw new Error(stitchResult.error || 'Floor stitching failed');
    }
    
    onProgress?.('Complete!', 100);
    
    return {
      success: true,
      finalMeshUrl: stitchResult.combinedUrl,
      floorUrl: segmentResult.floorUrl,
      shellUrl: segmentResult.shellUrl,
      texturedFloorUrl: downloadResult.localUrl,
    };
    
  } catch (error: any) {
    console.error('[FloorRetexture] Pipeline failed:', error);
    return {
      success: false,
      finalMeshUrl: '',
      floorUrl: '',
      shellUrl: '',
      texturedFloorUrl: '',
      error: error.message,
    };
  }
}
