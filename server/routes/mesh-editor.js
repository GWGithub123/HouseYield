/**
 * Mesh Editing API Routes
 * 
 * Provides endpoints for advanced mesh editing operations:
 * - Furniture detection and removal
 * - Room reshaping (CSG operations)
 * - Mesh smoothing and repair
 * 
 * Uses Python backend with Open3D/Trimesh on GCP GPU worker
 */

import express from 'express';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();

// Configuration
const USE_GCP_WORKER = process.env.USE_GCP_WORKER === 'true';
const GCP_ZONE = process.env.GCP_ZONE || 'us-central1-c';
const GCP_INSTANCE = process.env.GCP_INSTANCE || 'photogrammetry-gpu-worker';
const SCRIPTS_DIR = path.join(process.cwd(), 'server', 'scripts');
const TEMP_DIR = '/tmp/mesh-editing';
const SCANS_DIR = path.join(process.cwd(), 'server', 'data', 'room-scans');

// Ensure temp directory exists
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

/**
 * Resolve mesh URL to local file path
 * Handles various URL formats:
 * - /api/room-scanner/scans/:scanId/model/:filename
 * - /edited-meshes/:filename
 * - Absolute file paths
 */
function resolveMeshPath(meshUrl) {
  // Handle room scanner API paths
  const roomScannerMatch = meshUrl.match(/\/api\/room-scanner\/scans\/([^/]+)\/model\/(.+)/);
  if (roomScannerMatch) {
    const [, scanId, filename] = roomScannerMatch;
    return path.join(SCANS_DIR, scanId, 'model', filename);
  }
  
  // Handle edited meshes path
  if (meshUrl.startsWith('/edited-meshes/')) {
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
 * Copy MTL and texture files from original mesh directory to edited mesh directory
 * This ensures edited meshes have all the assets they need to render properly
 */
async function copyMeshAssets(originalDir, editedDir, newObjFileName) {
  console.log('[MeshEditor] Copying mesh assets from:', originalDir, 'to:', editedDir);
  
  try {
    // Find and copy MTL files
    const files = fs.readdirSync(originalDir);
    const mtlFiles = files.filter(f => f.endsWith('.mtl'));
    const textureFiles = files.filter(f => 
      f.endsWith('.jpg') || f.endsWith('.jpeg') || 
      f.endsWith('.png') || f.endsWith('.tga') ||
      f.endsWith('.bmp')
    );
    
    // Read the OBJ file to find what material names Trimesh used
    const objPath = path.join(editedDir, newObjFileName);
    let usedMaterialNames = [];
    if (fs.existsSync(objPath)) {
      const objContent = fs.readFileSync(objPath, 'utf8');
      const usemtlMatches = objContent.match(/usemtl\s+(\S+)/g);
      if (usemtlMatches) {
        usedMaterialNames = usemtlMatches.map(m => m.replace('usemtl ', '').trim());
        console.log('[MeshEditor] Materials used in OBJ:', usedMaterialNames);
      }
    }
    
    // Copy MTL file with new name matching the OBJ
    if (mtlFiles.length > 0) {
      const originalMtl = path.join(originalDir, mtlFiles[0]);
      const newMtlName = newObjFileName.replace('.obj', '.mtl');
      const newMtl = path.join(editedDir, newMtlName);
      
      // Read original MTL content
      let mtlContent = fs.readFileSync(originalMtl, 'utf8');
      
      // Find material names defined in original MTL
      const originalMatNames = mtlContent.match(/newmtl\s+(\S+)/g);
      if (originalMatNames && usedMaterialNames.length > 0) {
        // Create mapping from old names to Trimesh names
        // Trimesh typically uses material_0, material_1, etc.
        originalMatNames.forEach((match, idx) => {
          const originalName = match.replace('newmtl ', '').trim();
          const trimeshName = usedMaterialNames[idx] || `material_${idx}`;
          if (originalName !== trimeshName) {
            console.log(`[MeshEditor] Remapping material: ${originalName} -> ${trimeshName}`);
            mtlContent = mtlContent.replace(`newmtl ${originalName}`, `newmtl ${trimeshName}`);
          }
        });
      }
      
      fs.writeFileSync(newMtl, mtlContent);
      console.log('[MeshEditor] Copied MTL:', newMtlName);
    }
    
    // Copy all texture files
    for (const texFile of textureFiles) {
      const src = path.join(originalDir, texFile);
      const dst = path.join(editedDir, texFile);
      if (!fs.existsSync(dst)) {
        fs.copyFileSync(src, dst);
        console.log('[MeshEditor] Copied texture:', texFile);
      }
    }
    
    // Also update the OBJ file to reference the new MTL name
    if (fs.existsSync(objPath)) {
      let objContent = fs.readFileSync(objPath, 'utf8');
      const newMtlName = newObjFileName.replace('.obj', '.mtl');
      // Replace any mtllib reference with the new MTL name
      objContent = objContent.replace(/mtllib\s+.+\.mtl/g, `mtllib ${newMtlName}`);
      fs.writeFileSync(objPath, objContent);
      console.log('[MeshEditor] Updated OBJ mtllib reference to:', newMtlName);
    }
    
  } catch (error) {
    console.error('[MeshEditor] Error copying mesh assets:', error);
    // Don't throw - the mesh will still work, just without textures
  }
}

/**
 * Execute mesh editing command
 * Can run locally or on GCP depending on configuration
 */
async function executeMeshEditor(command, args = []) {
  const scriptPath = path.join(SCRIPTS_DIR, 'mesh_editor.py');
  
  return new Promise((resolve, reject) => {
    let proc;
    
    if (USE_GCP_WORKER) {
      // Run on GCP GPU worker
      const remoteCmd = `python3 ~/.local/bin/mesh_editor.py ${command} ${args.join(' ')}`;
      proc = spawn('gcloud', [
        'compute', 'ssh', GCP_INSTANCE,
        '--zone', GCP_ZONE,
        '--command', remoteCmd
      ]);
    } else {
      // Run locally
      proc = spawn('python3', [scriptPath, command, ...args]);
    }
    
    let stdout = '';
    let stderr = '';
    
    proc.stdout.on('data', (data) => {
      stdout += data.toString();
      console.log('[MeshEditor]', data.toString().trim());
    });
    
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
      console.error('[MeshEditor]', data.toString().trim());
    });
    
    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true, stdout, stderr });
      } else {
        reject(new Error(`Mesh editor failed with code ${code}: ${stderr}`));
      }
    });
  });
}

// ============================================================================
// API Endpoints
// ============================================================================

/**
 * POST /api/mesh-editor/remove-furniture
 * 
 * Remove furniture from a room scan, leaving just the structural elements
 * (floor, walls, ceiling)
 */
router.post('/remove-furniture', async (req, res) => {
  try {
    const { meshUrl, floorHeight = 0, aggressive = false } = req.body;
    
    if (!meshUrl) {
      return res.status(400).json({ error: 'meshUrl required' });
    }
    
    console.log('[MeshEditor] 🪑 Removing furniture from:', meshUrl);
    
    const jobId = uuidv4();
    const inputPath = path.join(TEMP_DIR, `${jobId}_input.obj`);
    const outputPath = path.join(TEMP_DIR, `${jobId}_output.obj`);
    
    // Resolve mesh URL to local file path
    const localMeshPath = resolveMeshPath(meshUrl);
    console.log('[MeshEditor] Resolved path:', localMeshPath);
    
    if (!fs.existsSync(localMeshPath)) {
      console.log('[MeshEditor] File not found at:', localMeshPath);
      return res.status(404).json({ error: 'Mesh file not found', path: localMeshPath });
    }
    
    // Copy to temp
    fs.copyFileSync(localMeshPath, inputPath);
    
    // Execute furniture removal
    const args = [inputPath, outputPath, '--floor-height', String(floorHeight)];
    if (aggressive) args.push('--aggressive');
    
    const result = await executeMeshEditor('remove_furniture', args);
    
    // Parse result - extract JSON object from output (handles multi-line JSON)
    const jsonMatch = result.stdout.match(/\{[\s\S]*"success":\s*true[\s\S]*\}/);
    let stats = {};
    if (jsonMatch) {
      try {
        stats = JSON.parse(jsonMatch[0]);
      } catch (e) {
        console.log('[MeshEditor] Failed to parse stats JSON:', e.message);
      }
    }
    
    // Copy result to public directory
    const outputFileName = `furniture_removed_${jobId}.obj`;
    const publicOutput = path.join(process.cwd(), 'public', 'edited-meshes', outputFileName);
    
    if (!fs.existsSync(path.dirname(publicOutput))) {
      fs.mkdirSync(path.dirname(publicOutput), { recursive: true });
    }
    
    fs.copyFileSync(outputPath, publicOutput);
    
    // Also copy MTL and texture files from the original mesh directory
    const originalDir = path.dirname(localMeshPath);
    const editedDir = path.dirname(publicOutput);
    await copyMeshAssets(originalDir, editedDir, outputFileName);
    
    // Cleanup temp files
    fs.unlinkSync(inputPath);
    fs.unlinkSync(outputPath);
    
    res.json({
      success: true,
      outputUrl: `/edited-meshes/${outputFileName}`,
      mtlUrl: `/edited-meshes/${outputFileName.replace('.obj', '.mtl')}`,
      stats: {
        removedFaces: stats.removed_faces,
        originalFaces: stats.original_faces,
        remainingFaces: stats.remaining_faces,
      },
      jobId,
    });
    
  } catch (error) {
    console.error('[MeshEditor] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/mesh-editor/cut-opening
 * 
 * Cut an opening in a wall (doorway, window, etc.)
 */
router.post('/cut-opening', async (req, res) => {
  try {
    const { 
      meshUrl, 
      openingType = 'door',  // door, window, arch, box
      position,  // [x, y, z]
      size,      // [width, height, depth]
    } = req.body;
    
    if (!meshUrl || !position || !size) {
      return res.status(400).json({ error: 'meshUrl, position, and size required' });
    }
    
    console.log(`[MeshEditor] 🚪 Cutting ${openingType} at position:`, position);
    
    const jobId = uuidv4();
    const inputPath = path.join(TEMP_DIR, `${jobId}_input.obj`);
    const outputPath = path.join(TEMP_DIR, `${jobId}_output.obj`);
    
    // Resolve mesh URL to local file path
    const localMeshPath = resolveMeshPath(meshUrl);
    console.log('[MeshEditor] Resolved path:', localMeshPath);
    
    if (!fs.existsSync(localMeshPath)) {
      console.log('[MeshEditor] File not found at:', localMeshPath);
      return res.status(404).json({ error: 'Mesh file not found', path: localMeshPath });
    }
    
    fs.copyFileSync(localMeshPath, inputPath);
    
    // Execute CSG cut
    const args = [
      inputPath, outputPath,
      '--type', openingType,
      '--position', ...position.map(String),
      '--size', ...size.map(String),
    ];
    
    const result = await executeMeshEditor('cut_opening', args);
    
    // Copy result
    const outputFileName = `opening_${openingType}_${jobId}.obj`;
    const publicOutput = path.join(process.cwd(), 'public', 'edited-meshes', outputFileName);
    
    if (!fs.existsSync(path.dirname(publicOutput))) {
      fs.mkdirSync(path.dirname(publicOutput), { recursive: true });
    }
    
    fs.copyFileSync(outputPath, publicOutput);
    
    // Also copy MTL and texture files from the original mesh directory
    const originalDir = path.dirname(localMeshPath);
    const editedDir = path.dirname(publicOutput);
    await copyMeshAssets(originalDir, editedDir, outputFileName);
    
    // Cleanup
    fs.unlinkSync(inputPath);
    fs.unlinkSync(outputPath);
    
    res.json({
      success: true,
      outputUrl: `/edited-meshes/${outputFileName}`,
      mtlUrl: `/edited-meshes/${outputFileName.replace('.obj', '.mtl')}`,
      openingType,
      position,
      size,
      jobId,
    });
    
  } catch (error) {
    console.error('[MeshEditor] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/mesh-editor/smooth
 * 
 * Apply smoothing to reduce mesh artifacts
 */
router.post('/smooth', async (req, res) => {
  try {
    const { meshUrl, iterations = 3 } = req.body;
    
    if (!meshUrl) {
      return res.status(400).json({ error: 'meshUrl required' });
    }
    
    console.log('[MeshEditor] ✨ Smoothing mesh:', meshUrl);
    
    const jobId = uuidv4();
    const inputPath = path.join(TEMP_DIR, `${jobId}_input.obj`);
    const outputPath = path.join(TEMP_DIR, `${jobId}_output.obj`);
    
    // Resolve mesh URL to local file path
    const localMeshPath = resolveMeshPath(meshUrl);
    console.log('[MeshEditor] Resolved path:', localMeshPath);
    
    if (!fs.existsSync(localMeshPath)) {
      return res.status(404).json({ error: 'Mesh file not found', path: localMeshPath });
    }
    
    fs.copyFileSync(localMeshPath, inputPath);
    
    const result = await executeMeshEditor('smooth', [
      inputPath, outputPath, '--iterations', String(iterations)
    ]);
    
    const outputFileName = `smoothed_${jobId}.obj`;
    const publicOutput = path.join(process.cwd(), 'public', 'edited-meshes', outputFileName);
    
    if (!fs.existsSync(path.dirname(publicOutput))) {
      fs.mkdirSync(path.dirname(publicOutput), { recursive: true });
    }
    
    fs.copyFileSync(outputPath, publicOutput);
    
    fs.unlinkSync(inputPath);
    fs.unlinkSync(outputPath);
    
    res.json({
      success: true,
      outputUrl: `/edited-meshes/${outputFileName}`,
      iterations,
      jobId,
    });
    
  } catch (error) {
    console.error('[MeshEditor] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/mesh-editor/segment
 * 
 * Analyze mesh and segment into surfaces (floor, walls, ceiling, furniture)
 */
router.post('/segment', async (req, res) => {
  try {
    const { meshUrl } = req.body;
    
    if (!meshUrl) {
      return res.status(400).json({ error: 'meshUrl required' });
    }
    
    console.log('[MeshEditor] 🔍 Segmenting mesh:', meshUrl);
    
    const jobId = uuidv4();
    const inputPath = path.join(TEMP_DIR, `${jobId}_input.obj`);
    
    // Resolve mesh URL to local file path
    const localMeshPath = resolveMeshPath(meshUrl);
    console.log('[MeshEditor] Resolved path:', localMeshPath);
    
    if (!fs.existsSync(localMeshPath)) {
      return res.status(404).json({ error: 'Mesh file not found', path: localMeshPath });
    }
    
    fs.copyFileSync(localMeshPath, inputPath);
    
    const result = await executeMeshEditor('segment', [inputPath]);
    
    fs.unlinkSync(inputPath);
    
    // Parse segmentation results - extract JSON object from output
    const jsonMatch = result.stdout.match(/\{[\s\S]*\}/);
    let segments = {};
    if (jsonMatch) {
      try {
        segments = JSON.parse(jsonMatch[0]);
      } catch (e) {
        console.log('[MeshEditor] Failed to parse segment JSON:', e.message);
      }
    }
    
    res.json({
      success: true,
      segments,
      jobId,
    });
    
  } catch (error) {
    console.error('[MeshEditor] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/mesh-editor/fill-holes
 * 
 * Fill holes in mesh
 */
router.post('/fill-holes', async (req, res) => {
  try {
    const { meshUrl } = req.body;
    
    if (!meshUrl) {
      return res.status(400).json({ error: 'meshUrl required' });
    }
    
    console.log('[MeshEditor] 🔧 Filling holes in:', meshUrl);
    
    const jobId = uuidv4();
    const inputPath = path.join(TEMP_DIR, `${jobId}_input.obj`);
    const outputPath = path.join(TEMP_DIR, `${jobId}_output.obj`);
    
    // Resolve mesh URL to local file path
    const localMeshPath = resolveMeshPath(meshUrl);
    console.log('[MeshEditor] Resolved path:', localMeshPath);
    
    if (!fs.existsSync(localMeshPath)) {
      return res.status(404).json({ error: 'Mesh file not found', path: localMeshPath });
    }
    
    fs.copyFileSync(localMeshPath, inputPath);
    
    await executeMeshEditor('fill_holes', [inputPath, outputPath]);
    
    const outputFileName = `holes_filled_${jobId}.obj`;
    const publicOutput = path.join(process.cwd(), 'public', 'edited-meshes', outputFileName);
    
    if (!fs.existsSync(path.dirname(publicOutput))) {
      fs.mkdirSync(path.dirname(publicOutput), { recursive: true });
    }
    
    fs.copyFileSync(outputPath, publicOutput);
    
    fs.unlinkSync(inputPath);
    fs.unlinkSync(outputPath);
    
    res.json({
      success: true,
      outputUrl: `/edited-meshes/${outputFileName}`,
      jobId,
    });
    
  } catch (error) {
    console.error('[MeshEditor] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/mesh-editor/cut-polygon
 * 
 * Cut a polygon-shaped hole in a mesh using measured points.
 * This is the precision hole cutting tool that allows users to click
 * points on a wall to define a polygon shape, then cut that shape
 * through the mesh.
 */
router.post('/cut-polygon', async (req, res) => {
  try {
    const { 
      meshUrl, 
      points,        // Array of { x, y, z, normalX?, normalY?, normalZ? }
      extrudeDepth = 0.5,  // How deep to extrude the cut
      smoothEdges = true,   // Whether to smooth the cut edges
      viewerScale = 1,      // Scale factor applied by the viewer
      originalScanId = null, // Original scan ID for finding textures
    } = req.body;
    
    if (!meshUrl || !points || !Array.isArray(points) || points.length < 3) {
      return res.status(400).json({ 
        error: 'meshUrl and at least 3 points required',
        received: { meshUrl: !!meshUrl, pointsLength: points?.length }
      });
    }
    
    console.log(`[MeshEditor] 📐 Cutting polygon hole with ${points.length} points`);
    console.log('[MeshEditor] Points:', points.map(p => `(${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})`).join(' -> '));
    console.log('[MeshEditor] Viewer scale:', viewerScale);
    
    const jobId = uuidv4();
    const inputPath = path.join(TEMP_DIR, `${jobId}_input.obj`);
    const outputPath = path.join(TEMP_DIR, `${jobId}_output.obj`);
    const pointsFile = path.join(TEMP_DIR, `${jobId}_points.json`);
    
    // Resolve mesh URL to local file path
    const localMeshPath = resolveMeshPath(meshUrl);
    console.log('[MeshEditor] Resolved path:', localMeshPath);
    
    if (!fs.existsSync(localMeshPath)) {
      console.log('[MeshEditor] File not found at:', localMeshPath);
      return res.status(404).json({ error: 'Mesh file not found', path: localMeshPath });
    }
    
    // Copy input mesh
    fs.copyFileSync(localMeshPath, inputPath);
    
    // Write points to JSON file for Python to read
    fs.writeFileSync(pointsFile, JSON.stringify({
      points: points.map(p => ({
        position: [p.x, p.y, p.z],
        normal: p.normalX !== undefined ? [p.normalX, p.normalY, p.normalZ] : null,
      })),
      extrudeDepth,
      smoothEdges,
      viewerScale,  // Pass viewer scale to Python
    }));
    
    // Execute polygon cut
    const args = [inputPath, outputPath, '--points-file', pointsFile];
    
    const result = await executeMeshEditor('cut_polygon', args);
    
    // Parse result
    const jsonMatch = result.stdout.match(/\{[\s\S]*"success":\s*true[\s\S]*\}/);
    let stats = {};
    if (jsonMatch) {
      try {
        stats = JSON.parse(jsonMatch[0]);
      } catch (e) {
        console.log('[MeshEditor] Failed to parse stats JSON:', e.message);
      }
    }
    
    // Copy result to public directory
    const outputFileName = `polygon_cut_${jobId}.obj`;
    const publicOutput = path.join(process.cwd(), 'public', 'edited-meshes', outputFileName);
    
    if (!fs.existsSync(path.dirname(publicOutput))) {
      fs.mkdirSync(path.dirname(publicOutput), { recursive: true });
    }
    
    fs.copyFileSync(outputPath, publicOutput);
    
    // Find the original scan directory for texture files
    // If mesh is from /edited-meshes/, we need to find the original scan to get textures
    let originalDir = path.dirname(localMeshPath);
    
    // If the mesh is from edited-meshes, try to find the original scan directory
    if (meshUrl.startsWith('/edited-meshes/') || localMeshPath.includes('edited-meshes')) {
      // Check if we have an originalScanId passed from the frontend
      if (originalScanId) {
        const scanDir = path.join(SCANS_DIR, originalScanId, 'model');
        if (fs.existsSync(scanDir)) {
          originalDir = scanDir;
          console.log('[MeshEditor] Using original scan directory for textures:', originalDir);
        }
      } else {
        console.log('[MeshEditor] Warning: Editing an edited mesh without originalScanId - textures may be incorrect');
      }
    }
    
    const editedDir = path.dirname(publicOutput);
    await copyMeshAssets(originalDir, editedDir, outputFileName);
    
    // Cleanup temp files
    fs.unlinkSync(inputPath);
    fs.unlinkSync(outputPath);
    fs.unlinkSync(pointsFile);
    
    res.json({
      success: true,
      outputUrl: `/edited-meshes/${outputFileName}`,
      mtlUrl: `/edited-meshes/${outputFileName.replace('.obj', '.mtl')}`,
      pointCount: points.length,
      stats: {
        removedFaces: stats.removed_faces,
        originalFaces: stats.original_faces,
        remainingFaces: stats.remaining_faces,
      },
      jobId,
    });
    
  } catch (error) {
    console.error('[MeshEditor] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
