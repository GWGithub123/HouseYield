/**
 * Mesh Preprocessing API Routes
 * 
 * Provides endpoints for preparing photogrammetry scans before Meshy AI retexturing:
 * - Analyze mesh health (normals, watertight, face count)
 * - Repair common issues (inverted normals, holes, degenerates)
 * - Decimate high-poly scans for better Meshy performance
 * 
 * This solves the "blue model" problem where Meshy fails to texture
 * photogrammetry scans due to inverted normals or broken geometry.
 * 
 * Uses Python + Trimesh for mesh processing (server/scripts/preprocess_mesh.py)
 */

import express from 'express';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();

// ============================================================================
// Configuration
// ============================================================================

const SCANS_DIR = path.join(process.cwd(), 'server', 'data', 'room-scans');
const PREPROCESSED_DIR = path.join(process.cwd(), 'public', 'preprocessed-meshes');
const PYTHON_SCRIPT = path.join(process.cwd(), 'server', 'scripts', 'preprocess_mesh.py');

// Ensure output directory exists
if (!fs.existsSync(PREPROCESSED_DIR)) {
  fs.mkdirSync(PREPROCESSED_DIR, { recursive: true });
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Resolve mesh URL to local file path
 * Handles various URL formats from the frontend
 */
function resolveMeshPath(meshUrl) {
  // Handle room scanner API paths
  const roomScannerMatch = meshUrl.match(/\/api\/room-scanner\/scans\/([^/]+)\/model\/(.+)/);
  if (roomScannerMatch) {
    const [, scanId, filename] = roomScannerMatch;
    return path.join(SCANS_DIR, scanId, 'model', filename);
  }
  
  // Handle photogrammetry paths
  const photogrammetryMatch = meshUrl.match(/\/api\/photogrammetry\/scans\/([^/]+)\/mesh/);
  if (photogrammetryMatch) {
    const [, scanId] = photogrammetryMatch;
    return path.join(process.cwd(), 'server', 'data', 'photogrammetry', scanId, 'mesh.glb');
  }
  
  // Handle edited meshes path
  if (meshUrl.startsWith('/edited-meshes/')) {
    return path.join(process.cwd(), 'public', meshUrl);
  }
  
  // Handle preprocessed meshes path
  if (meshUrl.startsWith('/preprocessed-meshes/')) {
    return path.join(process.cwd(), 'public', meshUrl);
  }
  
  // Handle retextured meshes path
  if (meshUrl.startsWith('/retextured-meshes/')) {
    return path.join(process.cwd(), 'public', meshUrl);
  }
  
  // Handle other absolute URL paths (serve from public)
  if (meshUrl.startsWith('/')) {
    return path.join(process.cwd(), 'public', meshUrl);
  }
  
  // Assume it's already an absolute file path
  return meshUrl;
}

/**
 * Run the Python preprocessing script
 */
function runPythonPreprocess(inputPath, outputPath, options = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      PYTHON_SCRIPT,
      inputPath,
      outputPath,
      '--json-output',
    ];
    
    // Add optional arguments
    if (options.targetFaces) {
      args.push('--target-faces', options.targetFaces.toString());
    }
    if (options.decimationRatio) {
      args.push('--decimation-ratio', options.decimationRatio.toString());
    }
    if (options.skipDecimation) {
      args.push('--skip-decimation');
    }
    if (options.skipHoleFill) {
      args.push('--skip-hole-fill');
    }
    if (options.aggressive) {
      args.push('--aggressive');
    }
    if (options.analyzeOnly) {
      args.push('--analyze-only');
    }
    
    console.log('[MeshPreprocess] Running Python script:', args.join(' '));
    
    const pythonProcess = spawn('python3', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    
    let stdout = '';
    let stderr = '';
    
    pythonProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    pythonProcess.stderr.on('data', (data) => {
      stderr += data.toString();
      // Log progress messages from Python
      console.log('[MeshPreprocess]', data.toString().trim());
    });
    
    pythonProcess.on('close', (code) => {
      console.log('[MeshPreprocess] Python process exited with code:', code);
      
      if (code !== 0) {
        // Try to parse error from stdout (JSON) or use stderr
        try {
          const result = JSON.parse(stdout);
          reject(new Error(result.error || 'Preprocessing failed'));
        } catch (e) {
          reject(new Error(stderr || `Preprocessing failed with exit code ${code}`));
        }
        return;
      }
      
      try {
        const result = JSON.parse(stdout);
        resolve(result);
      } catch (e) {
        reject(new Error(`Failed to parse Python output: ${e.message}`));
      }
    });
    
    pythonProcess.on('error', (err) => {
      reject(new Error(`Failed to run Python script: ${err.message}`));
    });
  });
}

/**
 * Run Python script with raw arguments array (for segment-floor, stitch-floor, etc.)
 */
function runPythonWithArgs(rawArgs) {
  return new Promise((resolve, reject) => {
    const args = [PYTHON_SCRIPT, ...rawArgs];
    
    console.log('[MeshPreprocess] Running Python script with args:', args.join(' '));
    
    const pythonProcess = spawn('python3', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    
    let stdout = '';
    let stderr = '';
    
    pythonProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    pythonProcess.stderr.on('data', (data) => {
      stderr += data.toString();
      console.log('[MeshPreprocess]', data.toString().trim());
    });
    
    pythonProcess.on('close', (code) => {
      console.log('[MeshPreprocess] Python process exited with code:', code);
      
      if (code !== 0) {
        try {
          const result = JSON.parse(stdout);
          reject(new Error(result.error || 'Python script failed'));
        } catch (e) {
          reject(new Error(stderr || `Python script failed with exit code ${code}`));
        }
        return;
      }
      
      try {
        const result = JSON.parse(stdout);
        resolve(result);
      } catch (e) {
        reject(new Error(`Failed to parse Python output: ${e.message}`));
      }
    });
    
    pythonProcess.on('error', (err) => {
      reject(new Error(`Failed to run Python script: ${err.message}`));
    });
  });
}

/**
 * Run mesh analysis only (no modifications)
 */
function runPythonAnalyze(inputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      PYTHON_SCRIPT,
      inputPath,
      'dummy-output.glb',  // Not used in analyze mode
      '--analyze-only',
      '--json-output',
    ];
    
    console.log('[MeshPreprocess] Analyzing mesh:', inputPath);
    
    const pythonProcess = spawn('python3', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    
    let stdout = '';
    let stderr = '';
    
    pythonProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    pythonProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    pythonProcess.on('close', (code) => {
      if (code !== 0) {
        try {
          const result = JSON.parse(stdout);
          reject(new Error(result.error || 'Analysis failed'));
        } catch (e) {
          reject(new Error(stderr || `Analysis failed with exit code ${code}`));
        }
        return;
      }
      
      try {
        const result = JSON.parse(stdout);
        resolve(result);
      } catch (e) {
        reject(new Error(`Failed to parse Python output: ${e.message}`));
      }
    });
    
    pythonProcess.on('error', (err) => {
      reject(new Error(`Failed to run Python script: ${err.message}`));
    });
  });
}

// ============================================================================
// API Endpoints
// ============================================================================

/**
 * POST /api/mesh/preprocess/analyze
 * 
 * Analyze mesh health without modifying it.
 * Returns diagnostic info about the mesh.
 * 
 * Request body:
 * - meshUrl: string - Path to the mesh file
 * 
 * Response:
 * - success: boolean
 * - analysis: { is_watertight, is_winding_consistent, face_count, ... }
 * - needsRepair: boolean - Whether the mesh needs preprocessing
 * - repairRecommendations: string[] - Suggested fixes
 */
router.post('/analyze', async (req, res) => {
  try {
    const { meshUrl } = req.body;
    
    if (!meshUrl) {
      return res.status(400).json({
        success: false,
        error: 'meshUrl is required',
      });
    }
    
    console.log('[MeshPreprocess] 🔍 Analyzing mesh:', meshUrl);
    
    // Resolve to local path
    const localPath = resolveMeshPath(meshUrl);
    
    if (!fs.existsSync(localPath)) {
      return res.status(404).json({
        success: false,
        error: 'Mesh file not found',
        path: localPath,
      });
    }
    
    // Run Python analysis
    const result = await runPythonAnalyze(localPath);
    
    if (!result.success) {
      return res.status(500).json({
        success: false,
        error: result.error || 'Analysis failed',
      });
    }
    
    const analysis = result.analysis;
    
    // Determine if mesh needs repair and what repairs are recommended
    const repairRecommendations = [];
    let needsRepair = false;
    
    if (!analysis.is_winding_consistent) {
      repairRecommendations.push('Fix normals: inconsistent winding detected (faces may be inside-out)');
      needsRepair = true;
    }
    
    if (analysis.has_degenerate_faces && analysis.degenerate_count > 0) {
      repairRecommendations.push(`Remove ${analysis.degenerate_count} degenerate faces (zero-area triangles)`);
      needsRepair = true;
    }
    
    if (analysis.face_count > 100000) {
      repairRecommendations.push(`Decimate mesh: ${analysis.face_count} faces is high for Meshy (recommend ~100k)`);
      needsRepair = true;
    }
    
    if (!analysis.is_watertight) {
      repairRecommendations.push('Fill holes: mesh has gaps that may cause texture bleeding');
      // Not critical, but recommended
    }
    
    console.log('[MeshPreprocess] ✅ Analysis complete. Needs repair:', needsRepair);
    
    res.json({
      success: true,
      analysis,
      needsRepair,
      repairRecommendations,
    });
    
  } catch (error) {
    console.error('[MeshPreprocess] Analysis error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/mesh/preprocess/repair
 * 
 * Preprocess a mesh for Meshy AI retexturing.
 * Applies repairs and decimation, returns URL to cleaned mesh.
 * 
 * Request body:
 * - meshUrl: string - Path to the mesh file
 * - targetFaces: number - Target face count (default: 100000)
 * - decimationRatio: number - Decimation ratio 0-1 (default: 0.1)
 * - skipDecimation: boolean - Skip decimation step
 * - skipHoleFill: boolean - Skip hole filling
 * - aggressive: boolean - Aggressive repairs for broken meshes
 * 
 * Response:
 * - success: boolean
 * - preprocessedUrl: string - URL to the cleaned mesh
 * - originalAnalysis: object - Mesh stats before repair
 * - finalAnalysis: object - Mesh stats after repair
 * - repairs: object - What was fixed
 * - processingTimeMs: number
 */
router.post('/repair', async (req, res) => {
  try {
    const {
      meshUrl,
      targetFaces = 100000,
      decimationRatio = 0.1,
      skipDecimation = false,
      skipHoleFill = false,
      aggressive = false,
    } = req.body;
    
    if (!meshUrl) {
      return res.status(400).json({
        success: false,
        error: 'meshUrl is required',
      });
    }
    
    console.log('[MeshPreprocess] 🔧 Preprocessing mesh:', meshUrl);
    console.log('[MeshPreprocess] Options:', {
      targetFaces,
      decimationRatio,
      skipDecimation,
      skipHoleFill,
      aggressive,
    });
    
    // Resolve to local path
    const localPath = resolveMeshPath(meshUrl);
    
    if (!fs.existsSync(localPath)) {
      return res.status(404).json({
        success: false,
        error: 'Mesh file not found',
        path: localPath,
      });
    }
    
    // Generate output path
    const jobId = uuidv4();
    const outputFilename = `preprocessed_${jobId}.glb`;
    const outputPath = path.join(PREPROCESSED_DIR, outputFilename);
    const publicUrl = `/preprocessed-meshes/${outputFilename}`;
    
    // Run Python preprocessing
    const result = await runPythonPreprocess(localPath, outputPath, {
      targetFaces,
      decimationRatio,
      skipDecimation,
      skipHoleFill,
      aggressive,
    });
    
    if (!result.success) {
      return res.status(500).json({
        success: false,
        error: result.error || 'Preprocessing failed',
      });
    }
    
    console.log('[MeshPreprocess] ✅ Preprocessing complete!');
    console.log('[MeshPreprocess] Faces:', 
      result.original_analysis?.face_count, '->', 
      result.final_analysis?.face_count
    );
    
    res.json({
      success: true,
      preprocessedUrl: publicUrl,
      jobId,
      originalMeshUrl: meshUrl,
      originalAnalysis: result.original_analysis,
      finalAnalysis: result.final_analysis,
      repairs: result.repairs,
      processingTimeMs: result.processing_time_ms,
    });
    
  } catch (error) {
    console.error('[MeshPreprocess] Preprocessing error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/mesh/preprocess/auto
 * 
 * Smart preprocessing: analyze first, then repair only if needed.
 * Returns either the original mesh URL (if healthy) or preprocessed URL.
 * 
 * Request body:
 * - meshUrl: string - Path to the mesh file
 * - forceRepair: boolean - Force repairs even if not needed
 * - targetFaces: number - Target face count for decimation
 * 
 * Response:
 * - success: boolean
 * - meshUrl: string - URL to use (original or preprocessed)
 * - wasPreprocessed: boolean - Whether repairs were applied
 * - analysis: object - Mesh health info
 */
router.post('/auto', async (req, res) => {
  try {
    const {
      meshUrl,
      forceRepair = false,
      targetFaces = 100000,
      decimationRatio = 0.1,
    } = req.body;
    
    if (!meshUrl) {
      return res.status(400).json({
        success: false,
        error: 'meshUrl is required',
      });
    }
    
    console.log('[MeshPreprocess] 🤖 Auto-preprocessing mesh:', meshUrl);
    
    // Resolve to local path
    const localPath = resolveMeshPath(meshUrl);
    
    if (!fs.existsSync(localPath)) {
      return res.status(404).json({
        success: false,
        error: 'Mesh file not found',
        path: localPath,
      });
    }
    
    // Step 1: Analyze
    const analysisResult = await runPythonAnalyze(localPath);
    
    if (!analysisResult.success) {
      return res.status(500).json({
        success: false,
        error: analysisResult.error || 'Analysis failed',
      });
    }
    
    const analysis = analysisResult.analysis;
    
    // Check if repairs are needed
    const needsNormalFix = !analysis.is_winding_consistent;
    const needsDegenerateRemoval = analysis.degenerate_count > 0;
    const needsDecimation = analysis.face_count > targetFaces;
    const needsRepair = needsNormalFix || needsDegenerateRemoval || needsDecimation;
    
    if (!needsRepair && !forceRepair) {
      console.log('[MeshPreprocess] ✅ Mesh is healthy, no preprocessing needed');
      return res.json({
        success: true,
        meshUrl,  // Return original
        wasPreprocessed: false,
        analysis,
        message: 'Mesh is already optimized for Meshy AI',
      });
    }
    
    // Step 2: Preprocess
    console.log('[MeshPreprocess] Mesh needs repair. Processing...');
    
    const jobId = uuidv4();
    const outputFilename = `preprocessed_${jobId}.glb`;
    const outputPath = path.join(PREPROCESSED_DIR, outputFilename);
    const publicUrl = `/preprocessed-meshes/${outputFilename}`;
    
    const result = await runPythonPreprocess(localPath, outputPath, {
      targetFaces,
      decimationRatio,
      aggressive: needsNormalFix, // Use aggressive mode if normals are bad
    });
    
    if (!result.success) {
      return res.status(500).json({
        success: false,
        error: result.error || 'Preprocessing failed',
      });
    }
    
    console.log('[MeshPreprocess] ✅ Auto-preprocessing complete!');
    
    res.json({
      success: true,
      meshUrl: publicUrl,  // Return preprocessed URL
      wasPreprocessed: true,
      originalMeshUrl: meshUrl,
      originalAnalysis: result.original_analysis,
      finalAnalysis: result.final_analysis,
      repairs: result.repairs,
      processingTimeMs: result.processing_time_ms,
    });
    
  } catch (error) {
    console.error('[MeshPreprocess] Auto-preprocessing error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/mesh/preprocess/status
 * 
 * Check if preprocessing service is available.
 */
router.get('/status', async (req, res) => {
  try {
    // Check if Python script exists
    const scriptExists = fs.existsSync(PYTHON_SCRIPT);
    
    if (!scriptExists) {
      return res.json({
        success: true,
        available: false,
        error: 'Preprocessing script not found',
      });
    }
    
    // Try to run a quick Python check
    const testResult = await new Promise((resolve) => {
      const pythonProcess = spawn('python3', ['-c', 'import trimesh; print("OK")'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      
      let stdout = '';
      pythonProcess.stdout.on('data', (data) => {
        stdout += data.toString();
      });
      
      pythonProcess.on('close', (code) => {
        resolve({
          code,
          hasTrimesh: stdout.includes('OK'),
        });
      });
      
      pythonProcess.on('error', () => {
        resolve({ code: 1, hasTrimesh: false });
      });
      
      // Timeout after 5 seconds
      setTimeout(() => {
        pythonProcess.kill();
        resolve({ code: 1, hasTrimesh: false });
      }, 5000);
    });
    
    res.json({
      success: true,
      available: testResult.code === 0 && testResult.hasTrimesh,
      pythonAvailable: testResult.code === 0,
      trimeshAvailable: testResult.hasTrimesh,
      scriptPath: PYTHON_SCRIPT,
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * DELETE /api/mesh/preprocess/cleanup
 * 
 * Clean up old preprocessed files (older than 24 hours)
 */
router.delete('/cleanup', async (req, res) => {
  try {
    const maxAgeMs = 24 * 60 * 60 * 1000; // 24 hours
    const now = Date.now();
    let deletedCount = 0;
    
    if (fs.existsSync(PREPROCESSED_DIR)) {
      const files = fs.readdirSync(PREPROCESSED_DIR);
      
      for (const file of files) {
        const filePath = path.join(PREPROCESSED_DIR, file);
        const stats = fs.statSync(filePath);
        const age = now - stats.mtimeMs;
        
        if (age > maxAgeMs) {
          fs.unlinkSync(filePath);
          deletedCount++;
        }
      }
    }
    
    console.log('[MeshPreprocess] 🧹 Cleanup complete. Deleted', deletedCount, 'files');
    
    res.json({
      success: true,
      deletedCount,
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ============================================================================
// FLOOR SEGMENTATION ENDPOINTS
// ============================================================================

/**
 * POST /api/mesh/preprocess/segment-floor
 * 
 * Segment the floor from a room scan for targeted Meshy retexturing.
 * This is the preferred method for flooring renovations - much better results!
 * 
 * Workflow:
 * 1. Preprocess the mesh (align, clean, fix normals)
 * 2. Detect floor faces (horizontal surfaces at bottom)
 * 3. Export floor as separate GLB (send this to Meshy)
 * 4. Export room shell as separate GLB (walls/ceiling)
 * 
 * Request body:
 * - meshUrl: string - Path to the mesh file
 * - angleToleranceDegrees: number - Max degrees from vertical for floor (default 15)
 * 
 * Response:
 * - success: boolean
 * - floorUrl: string - URL to floor segment GLB (send to Meshy)
 * - shellUrl: string - URL to room shell GLB (keep original walls)
 * - floorInfo: { floor_faces, shell_faces, floor_level, floor_percent }
 */
router.post('/segment-floor', async (req, res) => {
  try {
    const { meshUrl, angleToleranceDegrees = 15 } = req.body;
    
    if (!meshUrl) {
      return res.status(400).json({
        success: false,
        error: 'meshUrl is required',
      });
    }
    
    console.log('[MeshPreprocess] 🏠 Segmenting floor from mesh:', meshUrl);
    
    // Resolve to local path
    const localPath = resolveMeshPath(meshUrl);
    
    if (!fs.existsSync(localPath)) {
      return res.status(404).json({
        success: false,
        error: `Mesh file not found: ${localPath}`,
      });
    }
    
    // Generate output paths
    const jobId = uuidv4();
    const floorFileName = `floor_${jobId}.glb`;
    const shellFileName = `shell_${jobId}.glb`;
    const floorPath = path.join(PREPROCESSED_DIR, floorFileName);
    const shellPath = path.join(PREPROCESSED_DIR, shellFileName);
    
    // Run Python floor segmentation
    const pythonArgs = [
      localPath,
      floorPath, // output_path (not used in segment mode but required)
      '--segment-floor',
      '--floor-output', floorPath,
      '--shell-output', shellPath,
      '--json-output',
    ];
    
    console.log('[MeshPreprocess] Running floor segmentation...');
    const result = await runPythonWithArgs(pythonArgs);
    
    if (!result.success) {
      console.error('[MeshPreprocess] Floor segmentation failed:', result.error);
      return res.status(500).json({
        success: false,
        error: result.error || 'Floor segmentation failed',
      });
    }
    
    console.log('[MeshPreprocess] ✅ Floor segmentation complete');
    console.log('[MeshPreprocess] Floor:', result.floor_info.floor_faces, 'faces');
    console.log('[MeshPreprocess] Shell:', result.floor_info.shell_faces, 'faces');
    
    res.json({
      success: true,
      jobId,
      floorUrl: `/preprocessed-meshes/${floorFileName}`,
      shellUrl: `/preprocessed-meshes/${shellFileName}`,
      floorInfo: result.floor_info,
      originalFaces: result.original_faces,
      processingTimeMs: result.processing_time_ms,
    });
    
  } catch (error) {
    console.error('[MeshPreprocess] Floor segmentation error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/mesh/preprocess/stitch-floor
 * 
 * Stitch a textured floor (from Meshy) back into the original room shell.
 * This creates the final renovated room with new flooring.
 * 
 * Request body:
 * - shellUrl: string - Path to room shell (from segment-floor)
 * - texturedFloorUrl: string - Path to AI-textured floor from Meshy
 * 
 * Response:
 * - success: boolean
 * - combinedUrl: string - URL to final combined room model
 */
router.post('/stitch-floor', async (req, res) => {
  try {
    const { shellUrl, texturedFloorUrl } = req.body;
    
    if (!shellUrl || !texturedFloorUrl) {
      return res.status(400).json({
        success: false,
        error: 'Both shellUrl and texturedFloorUrl are required',
      });
    }
    
    console.log('[MeshPreprocess] 🔧 Stitching floor back into room');
    console.log('[MeshPreprocess] Shell:', shellUrl);
    console.log('[MeshPreprocess] Textured floor:', texturedFloorUrl);
    
    // Resolve paths
    const shellPath = resolveMeshPath(shellUrl);
    const floorPath = resolveMeshPath(texturedFloorUrl);
    
    if (!fs.existsSync(shellPath)) {
      return res.status(404).json({
        success: false,
        error: `Shell file not found: ${shellPath}`,
      });
    }
    
    if (!fs.existsSync(floorPath)) {
      return res.status(404).json({
        success: false,
        error: `Textured floor file not found: ${floorPath}`,
      });
    }
    
    // Generate output path
    const jobId = uuidv4();
    const combinedFileName = `combined_${jobId}.glb`;
    const combinedPath = path.join(PREPROCESSED_DIR, combinedFileName);
    
    // Run Python stitch
    const pythonArgs = [
      'dummy', // input_path not used in stitch mode
      combinedPath,
      '--stitch',
      '--shell-path', shellPath,
      '--textured-floor-path', floorPath,
      '--json-output',
    ];
    
    console.log('[MeshPreprocess] Running stitch...');
    const result = await runPythonWithArgs(pythonArgs);
    
    if (!result.success) {
      console.error('[MeshPreprocess] Stitch failed:', result.error);
      return res.status(500).json({
        success: false,
        error: result.error || 'Stitch failed',
      });
    }
    
    console.log('[MeshPreprocess] ✅ Stitch complete');
    console.log('[MeshPreprocess] Total faces:', result.total_faces);
    
    res.json({
      success: true,
      jobId,
      combinedUrl: `/preprocessed-meshes/${combinedFileName}`,
      shellFaces: result.shell_faces,
      floorFaces: result.floor_faces,
      totalFaces: result.total_faces,
      processingTimeMs: result.processing_time_ms,
    });
    
  } catch (error) {
    console.error('[MeshPreprocess] Stitch error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
