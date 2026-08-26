/**
 * Mesh Segmentation API Routes
 * 
 * Provides endpoints for segmenting 3D meshes into surfaces:
 * - Geometric segmentation (trimesh): Fast, reliable for floors/walls/ceilings
 * - AI segmentation (GPT-4o Vision): Semantic understanding for objects/fixtures
 * 
 * Part of the Segmented Retexturing Pipeline:
 * 1. Segment mesh → 2. Generate texture (Gemini) → 3. Apply texture (Meshy) → 4. Reassemble
 */

import express from 'express';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import fetch from 'node-fetch';

const router = express.Router();

// Configuration
const SCRIPTS_DIR = path.join(process.cwd(), 'server', 'scripts');
const SCANS_DIR = path.join(process.cwd(), 'server', 'data', 'room-scans');
const SEGMENTS_DIR = path.join(process.cwd(), 'public', 'mesh-segments');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Ensure segments directory exists
if (!fs.existsSync(SEGMENTS_DIR)) {
  fs.mkdirSync(SEGMENTS_DIR, { recursive: true });
}

/**
 * POST /api/mesh/upload-obj
 * 
 * Receive OBJ content from client and save to server
 * (Used when client-side segmentation exports geometry)
 */
router.post('/upload-obj', (req, res) => {
  try {
    const { objContent, filename } = req.body;
    
    if (!objContent || !filename) {
      return res.status(400).json({
        success: false,
        error: 'objContent and filename are required'
      });
    }
    
    // Create unique segment directory
    const segmentId = uuidv4();
    const segmentDir = path.join(SEGMENTS_DIR, segmentId);
    fs.mkdirSync(segmentDir, { recursive: true });
    
    // Save OBJ file
    const filepath = path.join(segmentDir, filename);
    fs.writeFileSync(filepath, objContent, 'utf8');
    
    const url = `/mesh-segments/${segmentId}/${filename}`;
    
    console.log(`[MeshSegmentation] Uploaded OBJ: ${url}`);
    
    res.json({
      success: true,
      url,
      path: filepath,
      filename,
      size: objContent.length
    });
    
  } catch (error) {
    console.error('[MeshSegmentation] Upload error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/mesh/segment-preview
 * 
 * Quick segmentation for preview purposes - returns URL to segment OBJ
 * Uses the same Trimesh segmentation but just returns the segment file for 3D preview
 */
router.post('/segment-preview', async (req, res) => {
  try {
    const { meshUrl, surfaceType = 'floor' } = req.body;
    
    if (!meshUrl) {
      return res.status(400).json({
        success: false,
        error: 'meshUrl is required'
      });
    }
    
    console.log('[MeshSegmentation] 🔍 Preview segmentation:', surfaceType);
    
    // Resolve mesh path
    const meshPath = resolveMeshPath(meshUrl);
    
    if (!fs.existsSync(meshPath)) {
      return res.status(404).json({
        success: false,
        error: 'Mesh file not found',
        path: meshPath
      });
    }
    
    // Create output directory for this segment
    const segmentId = uuidv4();
    const outputDir = path.join(SEGMENTS_DIR, segmentId);
    
    // Run Python segmenter
    const result = await runMeshSegmenter(meshPath, surfaceType, outputDir);
    
    if (!result.success) {
      return res.status(500).json({
        success: false,
        error: result.error || 'Segmentation failed'
      });
    }
    
    // Get the segment info
    const segment = result.segments?.[surfaceType];
    
    if (!segment) {
      return res.status(404).json({
        success: false,
        error: `No ${surfaceType} segment found`
      });
    }
    
    // Return the segment URL for preview
    const segmentUrl = `/mesh-segments/${segmentId}/${segment.filename}`;
    
    console.log('[MeshSegmentation] ✅ Preview segment ready:', segmentUrl, segment.face_count, 'faces');
    
    res.json({
      success: true,
      segmentUrl,
      faceCount: segment.face_count,
      vertexCount: segment.vertex_count,
      bounds: segment.bounds,
      area: segment.bounds ? 
        (segment.bounds.max[0] - segment.bounds.min[0]) * 
        (segment.bounds.max[2] - segment.bounds.min[2]) : 0
    });
    
  } catch (error) {
    console.error('[MeshSegmentation] Preview error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Resolve mesh URL to local file path
 */
function resolveMeshPath(meshUrl) {
  // Handle room scanner API paths
  const roomScannerMatch = meshUrl.match(/\/api\/room-scanner\/scans\/([^/]+)\/model\/(.+)/);
  if (roomScannerMatch) {
    const [, scanId, filename] = roomScannerMatch;
    return path.join(SCANS_DIR, scanId, 'model', filename);
  }
  
  // Handle edited meshes
  if (meshUrl.startsWith('/edited-meshes/')) {
    return path.join(process.cwd(), 'public', meshUrl);
  }
  
  // Handle retextured meshes
  if (meshUrl.startsWith('/retextured-meshes/')) {
    return path.join(process.cwd(), 'public', meshUrl);
  }
  
  // Handle mesh segments
  if (meshUrl.startsWith('/mesh-segments/')) {
    return path.join(process.cwd(), 'public', meshUrl);
  }
  
  // Handle other absolute paths
  if (meshUrl.startsWith('/')) {
    return path.join(process.cwd(), 'public', meshUrl);
  }
  
  return meshUrl;
}

/**
 * Run the Python mesh segmenter script
 */
async function runMeshSegmenter(meshPath, surfaceType, outputDir) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(SCRIPTS_DIR, 'mesh_segmenter.py');
    
    console.log('[MeshSegmentation] Running segmenter:', {
      script: scriptPath,
      mesh: meshPath,
      surface: surfaceType,
      output: outputDir
    });
    
    const proc = spawn('python3', [scriptPath, meshPath, surfaceType, outputDir]);
    
    let stdout = '';
    let stderr = '';
    
    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
      console.log('[MeshSegmenter]', data.toString().trim());
    });
    
    proc.on('close', (code) => {
      if (code === 0) {
        try {
          // Parse JSON result from stdout
          const result = JSON.parse(stdout);
          resolve(result);
        } catch (e) {
          reject(new Error(`Failed to parse segmenter output: ${e.message}`));
        }
      } else {
        reject(new Error(`Segmenter failed with code ${code}: ${stderr}`));
      }
    });
    
    proc.on('error', (err) => {
      reject(new Error(`Failed to start segmenter: ${err.message}`));
    });
  });
}

/**
 * Render mesh from a specific angle for AI analysis
 * Uses Three.js headless rendering via puppeteer or returns existing captures
 */
async function renderMeshForAI(meshPath, viewAngles = ['top', 'front', 'side']) {
  // For now, we'll use a simpler approach: capture the existing texture atlas
  // In production, you'd use puppeteer + Three.js for proper renders
  
  const renders = [];
  
  // Check if there's an existing texture/render we can use
  const meshDir = path.dirname(meshPath);
  const textureFiles = fs.readdirSync(meshDir).filter(f => 
    f.endsWith('.jpg') || f.endsWith('.png') || f.endsWith('.jpeg')
  );
  
  for (const texFile of textureFiles.slice(0, 3)) {
    const texPath = path.join(meshDir, texFile);
    const texBuffer = fs.readFileSync(texPath);
    renders.push({
      angle: texFile.replace(/\.[^.]+$/, ''),
      base64: texBuffer.toString('base64'),
      mimeType: texFile.endsWith('.png') ? 'image/png' : 'image/jpeg'
    });
  }
  
  return renders;
}

/**
 * Use GPT-4o Vision to identify specific objects/surfaces in renders
 */
async function aiIdentifyObjects(renders, targetObject) {
  if (!OPENAI_API_KEY) {
    throw new Error('OpenAI API key not configured for AI segmentation');
  }
  
  console.log('[MeshSegmentation] Using GPT-4o Vision to identify:', targetObject);
  
  // Build image content for GPT-4o
  const imageContent = renders.map(render => ({
    type: 'image_url',
    image_url: {
      url: `data:${render.mimeType};base64,${render.base64}`,
      detail: 'high'
    }
  }));
  
  const prompt = `You are analyzing 3D room scan images to identify specific surfaces for retexturing.

TARGET: Identify the "${targetObject}" in these images.

For each image, describe:
1. Where the ${targetObject} is located (top/bottom/left/right/center of image)
2. Approximate percentage of the image it covers
3. Any distinguishing features that help identify it
4. Confidence level (high/medium/low)

Also provide a JSON object with bounding box estimates (normalized 0-1 coordinates):
{
  "found": true/false,
  "confidence": 0.0-1.0,
  "regions": [
    {"x1": 0.0, "y1": 0.0, "x2": 1.0, "y2": 1.0, "view": "image_index"}
  ],
  "description": "Brief description of the ${targetObject}"
}

Analyze the images now.`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              ...imageContent
            ]
          }
        ],
        max_tokens: 1500,
      })
    });
    
    const result = await response.json();
    
    if (result.error) {
      throw new Error(result.error.message);
    }
    
    const content = result.choices?.[0]?.message?.content || '';
    
    // Extract JSON from response
    const jsonMatch = content.match(/\{[\s\S]*"found"[\s\S]*\}/);
    let aiResult = null;
    
    if (jsonMatch) {
      try {
        aiResult = JSON.parse(jsonMatch[0]);
      } catch (e) {
        console.log('[MeshSegmentation] Could not parse AI JSON, using text analysis');
      }
    }
    
    return {
      success: true,
      targetObject,
      analysis: content,
      structuredResult: aiResult,
      renders: renders.length
    };
    
  } catch (error) {
    console.error('[MeshSegmentation] GPT-4o Vision error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}


// ============================================================================
// API Endpoints
// ============================================================================

/**
 * POST /api/mesh/segment
 * 
 * Segment a mesh by surface type using geometric analysis (trimesh)
 * 
 * Request body:
 * - meshUrl: string - Path to the mesh file
 * - surfaceType: 'floor' | 'walls' | 'ceiling' | 'countertops' | 'all'
 * 
 * Response:
 * - success: boolean
 * - segments: { [surfaceType]: { path, filename, faceCount } }
 * - remainder: { path, filename, faceCount }
 */
router.post('/segment', async (req, res) => {
  try {
    const { meshUrl, surfaceType = 'floor' } = req.body;
    
    if (!meshUrl) {
      return res.status(400).json({ success: false, error: 'meshUrl is required' });
    }
    
    console.log('[MeshSegmentation] 🔪 Segmenting mesh:', meshUrl);
    console.log('[MeshSegmentation] Surface type:', surfaceType);
    
    // Resolve mesh path
    const localMeshPath = resolveMeshPath(meshUrl);
    
    if (!fs.existsSync(localMeshPath)) {
      return res.status(404).json({
        success: false,
        error: 'Mesh file not found',
        path: localMeshPath
      });
    }
    
    // Create output directory for this segmentation job
    const jobId = uuidv4();
    const outputDir = path.join(SEGMENTS_DIR, jobId);
    
    // Run the Python segmenter
    const result = await runMeshSegmenter(localMeshPath, surfaceType, outputDir);
    
    if (!result.success) {
      return res.status(500).json({
        success: false,
        error: result.error || 'Segmentation failed'
      });
    }
    
    // Convert local paths to URL paths
    const segments = {};
    for (const [type, info] of Object.entries(result.segments || {})) {
      segments[type] = {
        ...info,
        url: `/mesh-segments/${jobId}/${info.filename}`
      };
    }
    
    let remainder = null;
    if (result.remainder) {
      remainder = {
        ...result.remainder,
        url: `/mesh-segments/${jobId}/${result.remainder.filename}`
      };
    }
    
    console.log('[MeshSegmentation] ✅ Segmentation complete');
    console.log('[MeshSegmentation] Segments:', Object.keys(segments));
    
    res.json({
      success: true,
      jobId,
      meshUrl,
      surfaceType,
      segments,
      remainder,
      bounds: result.bounds,
      totalFaces: result.total_faces,
      totalVertices: result.total_vertices
    });
    
  } catch (error) {
    console.error('[MeshSegmentation] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/mesh/segment-ai
 * 
 * Use AI vision to identify and segment specific objects
 * Hybrid approach: AI identifies regions, then trimesh extracts faces
 * 
 * Request body:
 * - meshUrl: string - Path to the mesh file
 * - targetObject: string - What to identify (e.g., "kitchen countertop", "bathroom vanity")
 * - useHybrid: boolean - Also run geometric segmentation for context
 */
router.post('/segment-ai', async (req, res) => {
  try {
    const { meshUrl, targetObject, useHybrid = true } = req.body;
    
    if (!meshUrl) {
      return res.status(400).json({ success: false, error: 'meshUrl is required' });
    }
    
    if (!targetObject) {
      return res.status(400).json({ success: false, error: 'targetObject is required' });
    }
    
    console.log('[MeshSegmentation] 🤖 AI Segmentation for:', targetObject);
    
    const localMeshPath = resolveMeshPath(meshUrl);
    
    if (!fs.existsSync(localMeshPath)) {
      return res.status(404).json({
        success: false,
        error: 'Mesh file not found'
      });
    }
    
    // Create job directory
    const jobId = uuidv4();
    const outputDir = path.join(SEGMENTS_DIR, jobId);
    fs.mkdirSync(outputDir, { recursive: true });
    
    // Step 1: Run geometric segmentation for context
    let geometricResult = null;
    if (useHybrid) {
      console.log('[MeshSegmentation] Running hybrid geometric segmentation...');
      geometricResult = await runMeshSegmenter(localMeshPath, 'all', outputDir);
    }
    
    // Step 2: Render mesh for AI analysis
    const renders = await renderMeshForAI(localMeshPath);
    
    if (renders.length === 0) {
      // No existing renders - fall back to geometric only
      console.log('[MeshSegmentation] No renders available for AI, using geometric only');
      
      // Map target object to geometric surface type
      const objectToSurface = {
        'floor': 'floor',
        'flooring': 'floor',
        'wall': 'walls',
        'walls': 'walls',
        'ceiling': 'ceiling',
        'countertop': 'countertops',
        'countertops': 'countertops',
        'counter': 'countertops',
        'kitchen counter': 'countertops',
        'bathroom counter': 'countertops',
        'vanity': 'countertops',
      };
      
      const surfaceType = objectToSurface[targetObject.toLowerCase()] || 'floor';
      
      if (!geometricResult) {
        geometricResult = await runMeshSegmenter(localMeshPath, surfaceType, outputDir);
      }
      
      return res.json({
        success: true,
        jobId,
        method: 'geometric_fallback',
        targetObject,
        segments: geometricResult?.segments || {},
        remainder: geometricResult?.remainder,
        note: 'Used geometric segmentation - no renders available for AI'
      });
    }
    
    // Step 3: AI analysis
    const aiResult = await aiIdentifyObjects(renders, targetObject);
    
    // Step 4: Combine AI insights with geometric data
    // For now, use geometric segmentation with AI-guided surface selection
    let bestSurfaceType = 'floor';
    
    if (aiResult.structuredResult?.found) {
      // Use AI to determine which geometric segment matches
      const desc = aiResult.structuredResult.description?.toLowerCase() || '';
      
      if (desc.includes('counter') || desc.includes('vanity') || desc.includes('cabinet top')) {
        bestSurfaceType = 'countertops';
      } else if (desc.includes('wall') || desc.includes('vertical')) {
        bestSurfaceType = 'walls';
      } else if (desc.includes('ceiling') || desc.includes('top surface')) {
        bestSurfaceType = 'ceiling';
      } else if (desc.includes('floor') || desc.includes('ground')) {
        bestSurfaceType = 'floor';
      }
    }
    
    // Re-run segmentation with AI-selected surface if needed
    if (!geometricResult || !geometricResult.segments?.[bestSurfaceType]) {
      geometricResult = await runMeshSegmenter(localMeshPath, bestSurfaceType, outputDir);
    }
    
    // Convert paths to URLs
    const segments = {};
    for (const [type, info] of Object.entries(geometricResult?.segments || {})) {
      segments[type] = {
        ...info,
        url: `/mesh-segments/${jobId}/${info.filename}`
      };
    }
    
    res.json({
      success: true,
      jobId,
      method: 'hybrid_ai_geometric',
      targetObject,
      aiAnalysis: aiResult.analysis,
      aiConfidence: aiResult.structuredResult?.confidence,
      selectedSurface: bestSurfaceType,
      segments,
      remainder: geometricResult?.remainder ? {
        ...geometricResult.remainder,
        url: `/mesh-segments/${jobId}/${geometricResult.remainder.filename}`
      } : null,
      bounds: geometricResult?.bounds
    });
    
  } catch (error) {
    console.error('[MeshSegmentation] AI Segmentation error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/mesh/segment/:jobId
 * 
 * Get segmentation results for a job
 */
router.get('/segment/:jobId', (req, res) => {
  try {
    const { jobId } = req.params;
    const metadataPath = path.join(SEGMENTS_DIR, jobId, 'segmentation.json');
    
    if (!fs.existsSync(metadataPath)) {
      return res.status(404).json({
        success: false,
        error: 'Segmentation job not found'
      });
    }
    
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    
    res.json({
      success: true,
      ...metadata
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /api/mesh/segment/:jobId
 * 
 * Clean up segmentation files
 */
router.delete('/segment/:jobId', (req, res) => {
  try {
    const { jobId } = req.params;
    const jobDir = path.join(SEGMENTS_DIR, jobId);
    
    if (fs.existsSync(jobDir)) {
      fs.rmSync(jobDir, { recursive: true, force: true });
    }
    
    res.json({ success: true, message: 'Segmentation files cleaned up' });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;
