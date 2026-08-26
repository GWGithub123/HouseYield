/**
 * Meshy AI Retexture API Routes
 * 
 * Provides endpoints for retexturing 3D meshes using Meshy AI:
 * - Create retexture tasks with text or image prompts
 * - Poll for task completion
 * - Download retextured models (GLB format with PBR maps)
 * 
 * Use case: Apply renovation visualizations to photogrammetry room scans
 * e.g., Replace carpet with hardwood flooring while preserving mesh geometry
 * 
 * API Reference: https://docs.meshy.ai/api-reference/retexture
 */

import express from 'express';
import fetch from 'node-fetch';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();

// ============================================================================
// Configuration
// ============================================================================

const MESHY_API_BASE = 'https://api.meshy.ai/openapi/v1';
const MESHY_API_KEY = process.env.Meshy_API_Key;
const SCANS_DIR = path.join(process.cwd(), 'server', 'data', 'room-scans');
const RETEXTURE_DIR = path.join(process.cwd(), 'public', 'retextured-meshes');

// Ensure retexture output directory exists
if (!fs.existsSync(RETEXTURE_DIR)) {
  fs.mkdirSync(RETEXTURE_DIR, { recursive: true });
}

// Meshy API headers
function getMeshyHeaders() {
  if (!MESHY_API_KEY) {
    throw new Error('Meshy API key not configured. Set Meshy_API_Key in .env');
  }
  return {
    'Authorization': `Bearer ${MESHY_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Resolve mesh URL to local file path
 * Same logic as mesh-editor.js for consistency
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
 * Convert file to base64 data URI for Meshy upload
 * Meshy accepts: .obj, .fbx, .glb, .gltf, .stl
 * Note: For large files (>5MB), use public URL instead
 */
function fileToDataUri(filePath) {
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  const mimeTypes = {
    'obj': 'model/obj',
    'fbx': 'application/octet-stream',
    'glb': 'model/gltf-binary',
    'gltf': 'model/gltf+json',
    'stl': 'model/stl',
  };
  
  const mime = mimeTypes[ext] || 'application/octet-stream';
  const buffer = fs.readFileSync(filePath);
  const base64 = buffer.toString('base64');
  
  return `data:${mime};base64,${base64}`;
}

/**
 * Get a publicly accessible URL for a mesh file
 * Uses NGROK_URL or PUBLIC_URL from environment
 */
function getPublicMeshUrl(meshUrl) {
  // Get public base URL from environment
  const publicBase = process.env.NGROK_URL || process.env.PUBLIC_URL || process.env.VITE_NGROK_URL;
  
  if (!publicBase) {
    return null; // No public URL configured
  }
  
  // Convert internal mesh URL to public URL
  // e.g., /api/room-scanner/scans/xxx/model/model.obj -> https://tunnel.url/api/room-scanner/scans/xxx/model/model.obj
  if (meshUrl.startsWith('/')) {
    return `${publicBase}${meshUrl}`;
  }
  
  return null;
}

/**
 * Store active retexture tasks for polling
 */
const activeTasks = new Map();

// ============================================================================
// API Endpoints
// ============================================================================

/**
 * POST /api/meshy/retexture
 * 
 * Create a new retexture task with Meshy AI
 * 
 * Request body:
 * - meshUrl: string - Path to the mesh file (local or URL)
 * - textPrompt: string - Text description of desired texture (e.g., "polished oak hardwood flooring")
 * - imagePrompt?: string - Optional URL to reference image for style guidance
 * - artStyle: 'realistic' | 'cartoon' | 'low-poly' | 'sculpture' | 'pbr' - Art style (default: realistic)
 * - enablePBR: boolean - Generate PBR maps (metallic, roughness, normal) (default: true)
 * - resolution?: '1024' | '2048' | '4096' - Texture resolution (default: 2048)
 * - negativePrompt?: string - What to avoid in the texture
 * - enableOriginalUV: boolean - Use original UVs (default: false for preprocessed meshes)
 * - autoPreprocess: boolean - Auto-preprocess mesh if needed (default: true)
 * 
 * Response:
 * - success: boolean
 * - taskId: string - Meshy task ID for polling
 * - jobId: string - Local job ID for tracking
 */
router.post('/retexture', async (req, res) => {
  try {
    const {
      meshUrl,
      textPrompt,
      imagePrompt,
      artStyle = 'realistic',
      enablePBR = true,
      resolution = '2048',
      negativePrompt,
      surfaceType = 'flooring', // Which surface to apply texture to: 'flooring', 'walls', 'countertops'
      enableOriginalUV = false, // Force Meshy to generate clean UVs (better for repaired meshes)
      autoPreprocess = true, // Auto-preprocess photogrammetry scans
    } = req.body;

    if (!meshUrl) {
      return res.status(400).json({ success: false, error: 'meshUrl is required' });
    }

    if (!textPrompt) {
      return res.status(400).json({ success: false, error: 'textPrompt is required' });
    }

    console.log('[Meshy] 🎨 Creating retexture task...');
    console.log('[Meshy] Mesh:', meshUrl);
    console.log('[Meshy] Prompt:', textPrompt);
    console.log('[Meshy] Art style:', artStyle);

    // Resolve mesh path
    const localMeshPath = resolveMeshPath(meshUrl);
    
    if (!fs.existsSync(localMeshPath)) {
      console.error('[Meshy] Mesh file not found:', localMeshPath);
      return res.status(404).json({ 
        success: false, 
        error: 'Mesh file not found',
        path: localMeshPath 
      });
    }

    // Determine model URL for Meshy API
    // Priority: 1. Public URL (via tunnel) 2. Data URI (for smaller files)
    const fileSize = fs.statSync(localMeshPath).size;
    const fileSizeMB = fileSize / (1024 * 1024);
    console.log('[Meshy] File size:', fileSizeMB.toFixed(2), 'MB');
    
    let modelUrl;
    const publicUrl = getPublicMeshUrl(meshUrl);
    
    if (publicUrl) {
      // Use public URL - more reliable for Meshy API
      console.log('[Meshy] Using public URL:', publicUrl);
      modelUrl = publicUrl;
    } else if (fileSizeMB < 5) {
      // Use data URI for smaller files when no public URL available
      console.log('[Meshy] Converting mesh to data URI (no public URL available)...');
      modelUrl = fileToDataUri(localMeshPath);
      console.log('[Meshy] Data URI length:', modelUrl.length);
    } else {
      // File too large and no public URL
      return res.status(400).json({
        success: false,
        error: 'File too large for data URI upload. Please configure NGROK_URL or PUBLIC_URL for public access.',
        fileSizeMB: fileSizeMB.toFixed(2),
      });
    }

    // Create Meshy retexture task
    // API Reference: https://docs.meshy.ai/api-reference/retexture
    // 
    // IMPORTANT: object_prompt describes WHAT the model is (the geometry)
    // text_style_prompt describes HOW it should look (the texture/material)
    // We specify which surface type should receive the new texture
    
    // Surface-specific object descriptions and style prompts
    const surfaceConfig = {
      flooring: {
        objectPrompt: 'interior room with horizontal floor surface, the floor is the flat horizontal ground plane at the bottom of the room',
        stylePrefix: 'Apply ONLY to the FLOOR surface (the horizontal ground plane): ',
        styleSuffix: '. Keep walls and ceiling with their original appearance. Only change the floor texture.',
        negativeAddition: 'walls, ceiling, vertical surfaces',
      },
      walls: {
        objectPrompt: 'interior room with vertical wall surfaces, the walls are the vertical planes surrounding the room',
        stylePrefix: 'Apply ONLY to the WALL surfaces (the vertical planes): ',
        styleSuffix: '. Keep floor and ceiling with their original appearance. Only change the wall textures.',
        negativeAddition: 'floor, ceiling, horizontal surfaces',
      },
      countertops: {
        objectPrompt: 'interior room with countertop surfaces, countertops are the horizontal work surfaces in kitchen or bathroom',
        stylePrefix: 'Apply ONLY to the COUNTERTOP surfaces: ',
        styleSuffix: '. Keep floor, walls, and other surfaces with their original appearance. Only change the countertop texture.',
        negativeAddition: 'floor, walls, ceiling',
      },
    };
    
    const config = surfaceConfig[surfaceType] || surfaceConfig.flooring;
    const objectDescription = config.objectPrompt;
    const enhancedStylePrompt = `${config.stylePrefix}${textPrompt}${config.styleSuffix}`;
    const enhancedNegativePrompt = negativePrompt 
      ? `${negativePrompt}, ${config.negativeAddition}`
      : config.negativeAddition;
    
    console.log('[Meshy] Surface type:', surfaceType);
    console.log('[Meshy] Object prompt:', objectDescription);
    console.log('[Meshy] Style prompt:', enhancedStylePrompt);
    
    const payload = {
      model_url: modelUrl,
      object_prompt: objectDescription,
      text_style_prompt: enhancedStylePrompt,
      art_style: artStyle,
      enable_pbr: enablePBR,
      resolution: parseInt(resolution, 10),
      negative_prompt: enhancedNegativePrompt,
      // CRITICAL: Disable original UVs for preprocessed meshes
      // This forces Meshy to generate clean UVs instead of using potentially broken ones
      enable_original_uv: enableOriginalUV,
    };

    // Add optional parameters
    if (imagePrompt) {
      payload.image_style_url = imagePrompt;
    }
    if (negativePrompt) {
      payload.negative_prompt = negativePrompt;
    }

    console.log('[Meshy] Sending request to Meshy API...');
    console.log('[Meshy] Using model_url type:', publicUrl ? 'public URL' : 'data URI');
    console.log('[Meshy] enable_original_uv:', enableOriginalUV);
    const response = await fetch(`${MESHY_API_BASE}/retexture`, {
      method: 'POST',
      headers: getMeshyHeaders(),
      body: JSON.stringify(payload),
    });

    const result = await response.json();
    console.log('[Meshy] API response:', JSON.stringify(result, null, 2));

    if (!response.ok) {
      console.error('[Meshy] API error:', result);
      return res.status(response.status).json({
        success: false,
        error: result.message || result.error || 'Meshy API error',
        details: result,
      });
    }

    // Store task info for polling
    const jobId = uuidv4();
    const taskId = result.result; // Meshy returns task ID in 'result' field
    
    activeTasks.set(jobId, {
      taskId,
      meshUrl,
      textPrompt,
      status: 'PENDING',
      createdAt: new Date().toISOString(),
    });

    console.log('[Meshy] ✅ Task created:', taskId);

    res.json({
      success: true,
      taskId,
      jobId,
      message: 'Retexture task created. Poll /api/meshy/status/:jobId for results.',
    });

  } catch (error) {
    console.error('[Meshy] Error creating retexture task:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/meshy/status/:jobId
 * 
 * Poll for retexture task status
 * 
 * Response:
 * - success: boolean
 * - status: 'PENDING' | 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'EXPIRED'
 * - progress: number (0-100)
 * - modelUrls?: { glb, fbx, obj, usdz } - URLs to download retextured model
 * - thumbnailUrl?: string - Preview image URL
 * - textureUrls?: { baseColor, metallic, roughness, normal } - PBR texture URLs
 */
router.get('/status/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    
    const taskInfo = activeTasks.get(jobId);
    if (!taskInfo) {
      return res.status(404).json({
        success: false,
        error: 'Task not found. It may have expired or never existed.',
      });
    }

    console.log('[Meshy] 📊 Checking status for task:', taskInfo.taskId);

    const response = await fetch(`${MESHY_API_BASE}/retexture/${taskInfo.taskId}`, {
      method: 'GET',
      headers: getMeshyHeaders(),
    });

    const result = await response.json();
    
    if (!response.ok) {
      console.error('[Meshy] Status check failed:', result);
      return res.status(response.status).json({
        success: false,
        error: result.message || 'Failed to check status',
      });
    }

    console.log('[Meshy] Status:', result.status, '| Progress:', result.progress);

    // Update stored task info
    taskInfo.status = result.status;
    taskInfo.progress = result.progress;

    const responseData = {
      success: true,
      jobId,
      taskId: taskInfo.taskId,
      status: result.status,
      progress: result.progress || 0,
      originalMeshUrl: taskInfo.meshUrl,
      textPrompt: taskInfo.textPrompt,
      createdAt: taskInfo.createdAt,
    };

    // If completed, include model URLs
    if (result.status === 'SUCCEEDED') {
      responseData.modelUrls = result.model_urls;
      responseData.thumbnailUrl = result.thumbnail_url;
      responseData.textureUrls = result.texture_urls;
      
      // Clean up from active tasks after a delay (keep for a few minutes for downloads)
      setTimeout(() => activeTasks.delete(jobId), 10 * 60 * 1000);
    }

    // If failed, include error info
    if (result.status === 'FAILED') {
      responseData.error = result.error_message || result.message || 'Retexture task failed';
      activeTasks.delete(jobId);
    }

    res.json(responseData);

  } catch (error) {
    console.error('[Meshy] Error checking status:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/meshy/download/:jobId
 * 
 * Download the retextured model from Meshy and save locally
 * 
 * Request body:
 * - format: 'glb' | 'fbx' | 'obj' | 'usdz' (default: glb)
 * 
 * Response:
 * - success: boolean
 * - localUrl: string - Local path to the downloaded model
 */
router.post('/download/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const { format = 'glb' } = req.body;
    
    const taskInfo = activeTasks.get(jobId);
    if (!taskInfo) {
      return res.status(404).json({
        success: false,
        error: 'Task not found',
      });
    }

    // First check current status to get model URLs
    console.log('[Meshy] 📥 Fetching model URLs for download...');
    const statusResponse = await fetch(`${MESHY_API_BASE}/retexture/${taskInfo.taskId}`, {
      method: 'GET',
      headers: getMeshyHeaders(),
    });

    const statusResult = await statusResponse.json();
    
    if (statusResult.status !== 'SUCCEEDED') {
      return res.status(400).json({
        success: false,
        error: `Task not ready for download. Status: ${statusResult.status}`,
      });
    }

    const modelUrls = statusResult.model_urls;
    if (!modelUrls || !modelUrls[format]) {
      return res.status(400).json({
        success: false,
        error: `Model format '${format}' not available`,
        availableFormats: Object.keys(modelUrls || {}),
      });
    }

    const modelUrl = modelUrls[format];
    console.log('[Meshy] Downloading from:', modelUrl);

    // Download the model
    const downloadResponse = await fetch(modelUrl);
    if (!downloadResponse.ok) {
      throw new Error(`Failed to download model: ${downloadResponse.status}`);
    }

    const buffer = await downloadResponse.buffer();
    
    // Save to local retextured meshes directory
    const timestamp = Date.now();
    const filename = `retextured_${timestamp}.${format}`;
    const localPath = path.join(RETEXTURE_DIR, filename);
    
    fs.writeFileSync(localPath, buffer);
    console.log('[Meshy] ✅ Model saved to:', localPath);

    // Also download thumbnail if available
    let thumbnailLocalUrl = null;
    if (statusResult.thumbnail_url) {
      try {
        const thumbResponse = await fetch(statusResult.thumbnail_url);
        if (thumbResponse.ok) {
          const thumbBuffer = await thumbResponse.buffer();
          const thumbFilename = `retextured_${timestamp}_thumb.png`;
          const thumbPath = path.join(RETEXTURE_DIR, thumbFilename);
          fs.writeFileSync(thumbPath, thumbBuffer);
          thumbnailLocalUrl = `/retextured-meshes/${thumbFilename}`;
        }
      } catch (thumbError) {
        console.warn('[Meshy] Failed to download thumbnail:', thumbError.message);
      }
    }

    // Download PBR textures if available
    const localTextureUrls = {};
    if (statusResult.texture_urls) {
      for (const [texType, texUrl] of Object.entries(statusResult.texture_urls)) {
        if (texUrl) {
          try {
            const texResponse = await fetch(texUrl);
            if (texResponse.ok) {
              const texBuffer = await texResponse.buffer();
              // Determine extension from URL or default to png
              const urlParts = texUrl.split('.');
              const texExt = urlParts[urlParts.length - 1].split('?')[0] || 'png';
              const texFilename = `retextured_${timestamp}_${texType}.${texExt}`;
              const texPath = path.join(RETEXTURE_DIR, texFilename);
              fs.writeFileSync(texPath, texBuffer);
              localTextureUrls[texType] = `/retextured-meshes/${texFilename}`;
            }
          } catch (texError) {
            console.warn(`[Meshy] Failed to download ${texType} texture:`, texError.message);
          }
        }
      }
    }

    res.json({
      success: true,
      localUrl: `/retextured-meshes/${filename}`,
      thumbnailUrl: thumbnailLocalUrl,
      textureUrls: localTextureUrls,
      format,
      fileSize: buffer.length,
      originalPrompt: taskInfo.textPrompt,
    });

  } catch (error) {
    console.error('[Meshy] Error downloading model:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/meshy/tasks
 * 
 * List all active retexture tasks
 */
router.get('/tasks', (req, res) => {
  const tasks = [];
  for (const [jobId, taskInfo] of activeTasks.entries()) {
    tasks.push({
      jobId,
      ...taskInfo,
    });
  }
  
  res.json({
    success: true,
    tasks,
    count: tasks.length,
  });
});

/**
 * DELETE /api/meshy/tasks/:jobId
 * 
 * Cancel/remove a task from tracking
 */
router.delete('/tasks/:jobId', (req, res) => {
  const { jobId } = req.params;
  
  if (activeTasks.has(jobId)) {
    activeTasks.delete(jobId);
    res.json({ success: true, message: 'Task removed' });
  } else {
    res.status(404).json({ success: false, error: 'Task not found' });
  }
});

/**
 * POST /api/meshy/retexture-and-wait
 * 
 * Convenience endpoint: Create task and poll until complete
 * 
 * WARNING: This is a long-running request (can take 1-3 minutes)
 * Use for simple integrations; for production, use separate create/poll
 */
router.post('/retexture-and-wait', async (req, res) => {
  try {
    const {
      meshUrl,
      textPrompt,
      imagePrompt,
      artStyle = 'realistic',
      enablePBR = true,
      resolution = '2048',
      negativePrompt,
      maxWaitSeconds = 180,
    } = req.body;

    if (!meshUrl || !textPrompt) {
      return res.status(400).json({
        success: false,
        error: 'meshUrl and textPrompt are required',
      });
    }

    console.log('[Meshy] 🎨 Starting retexture-and-wait...');

    // Resolve and validate mesh
    const localMeshPath = resolveMeshPath(meshUrl);
    if (!fs.existsSync(localMeshPath)) {
      return res.status(404).json({
        success: false,
        error: 'Mesh file not found',
      });
    }

    // Determine model URL for Meshy API
    const fileSize = fs.statSync(localMeshPath).size;
    const fileSizeMB = fileSize / (1024 * 1024);
    console.log('[Meshy] File size:', fileSizeMB.toFixed(2), 'MB');
    
    let modelUrl;
    const publicUrl = getPublicMeshUrl(meshUrl);
    
    if (publicUrl) {
      console.log('[Meshy] Using public URL:', publicUrl);
      modelUrl = publicUrl;
    } else if (fileSizeMB < 5) {
      console.log('[Meshy] Converting mesh to data URI...');
      modelUrl = fileToDataUri(localMeshPath);
    } else {
      return res.status(400).json({
        success: false,
        error: 'File too large. Configure NGROK_URL or PUBLIC_URL for public access.',
      });
    }

    // Create task
    // API Reference: https://docs.meshy.ai/api-reference/retexture
    const createPayload = {
      model_url: modelUrl,
      object_prompt: textPrompt.substring(0, 500), // What the object is
      text_style_prompt: textPrompt, // How it should look (required unless image_style_url provided)
      art_style: artStyle,
      enable_pbr: enablePBR,
      resolution: parseInt(resolution, 10),
    };
    if (imagePrompt) createPayload.image_style_url = imagePrompt;
    if (negativePrompt) createPayload.negative_prompt = negativePrompt;

    console.log('[Meshy] Sending request to Meshy API...');
    const createResponse = await fetch(`${MESHY_API_BASE}/retexture`, {
      method: 'POST',
      headers: getMeshyHeaders(),
      body: JSON.stringify(createPayload),
    });

    const createResult = await createResponse.json();
    if (!createResponse.ok) {
      console.error('[Meshy] API error:', createResult);
      return res.status(createResponse.status).json({
        success: false,
        error: createResult.message || createResult.error || 'Failed to create task',
        details: createResult,
      });
    }

    const taskId = createResult.result;
    console.log('[Meshy] Task created:', taskId);

    // Poll until complete
    const startTime = Date.now();
    const maxWaitMs = maxWaitSeconds * 1000;
    let lastStatus = 'PENDING';

    while (Date.now() - startTime < maxWaitMs) {
      await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds

      const statusResponse = await fetch(`${MESHY_API_BASE}/retexture/${taskId}`, {
        method: 'GET',
        headers: getMeshyHeaders(),
      });

      const statusResult = await statusResponse.json();
      lastStatus = statusResult.status;
      
      console.log(`[Meshy] Status: ${lastStatus} | Progress: ${statusResult.progress}%`);

      if (lastStatus === 'SUCCEEDED') {
        // Download the GLB model
        const glbUrl = statusResult.model_urls?.glb;
        if (!glbUrl) {
          return res.json({
            success: true,
            status: 'SUCCEEDED',
            modelUrls: statusResult.model_urls,
            textureUrls: statusResult.texture_urls,
            thumbnailUrl: statusResult.thumbnail_url,
            message: 'Task completed but no GLB URL available',
          });
        }

        // Download and save locally
        const downloadResponse = await fetch(glbUrl);
        const buffer = await downloadResponse.buffer();
        
        const timestamp = Date.now();
        const filename = `retextured_${timestamp}.glb`;
        const localPath = path.join(RETEXTURE_DIR, filename);
        fs.writeFileSync(localPath, buffer);

        console.log('[Meshy] ✅ Retexture complete, saved to:', localPath);

        return res.json({
          success: true,
          status: 'SUCCEEDED',
          localUrl: `/retextured-meshes/${filename}`,
          modelUrls: statusResult.model_urls,
          textureUrls: statusResult.texture_urls,
          thumbnailUrl: statusResult.thumbnail_url,
          processingTime: Math.round((Date.now() - startTime) / 1000),
        });
      }

      if (lastStatus === 'FAILED') {
        return res.json({
          success: false,
          status: 'FAILED',
          error: statusResult.error_message || 'Retexture failed',
        });
      }
    }

    // Timeout
    res.json({
      success: false,
      status: lastStatus,
      error: `Timeout after ${maxWaitSeconds} seconds. Task may still complete.`,
      taskId,
    });

  } catch (error) {
    console.error('[Meshy] Error in retexture-and-wait:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/meshy/retexture-segment
 * 
 * Retexture a pre-segmented mesh with a pre-generated texture.
 * This is the key endpoint for the Segmented Retexturing Pipeline.
 * 
 * WORKFLOW:
 * 1. Client segments mesh → gets floor_segment.obj
 * 2. Client generates texture with Gemini → gets texture.png URL
 * 3. Client calls this endpoint with segment + texture
 * 4. Meshy applies texture ONLY to that segment
 * 5. Client loads retextured segment + remainder.obj in scene
 * 
 * Request body:
 * - segmentMeshUrl: string - URL to the segmented mesh (e.g., floor_segment.obj)
 * - textureUrl: string - URL to the Gemini-generated seamless texture
 * - surfaceType: string - Type of surface for prompt context
 * - textPrompt?: string - Optional additional style description
 * - enableOriginalUV: boolean - Preserve original UV mapping (recommended: true)
 * - resolution: string - Texture resolution
 */
router.post('/retexture-segment', async (req, res) => {
  try {
    const {
      segmentMeshUrl,
      textureUrl,
      surfaceType = 'flooring',
      textPrompt = '',
      enableOriginalUV = true,
      artStyle = 'realistic',
      enablePBR = true,
      resolution = '2048',
    } = req.body;

    if (!segmentMeshUrl) {
      return res.status(400).json({ success: false, error: 'segmentMeshUrl is required' });
    }

    if (!textureUrl) {
      return res.status(400).json({ success: false, error: 'textureUrl is required' });
    }

    console.log('[Meshy] 🎨 Retexturing segment with custom texture');
    console.log('[Meshy] Segment:', segmentMeshUrl);
    console.log('[Meshy] Texture:', textureUrl);
    console.log('[Meshy] Surface type:', surfaceType);

    // Resolve segment mesh path
    const localMeshPath = resolveMeshPath(segmentMeshUrl);
    
    if (!fs.existsSync(localMeshPath)) {
      console.error('[Meshy] Segment mesh not found:', localMeshPath);
      return res.status(404).json({ 
        success: false, 
        error: 'Segment mesh file not found',
        path: localMeshPath 
      });
    }

    // Determine model URL for Meshy API
    const fileSize = fs.statSync(localMeshPath).size;
    const fileSizeMB = fileSize / (1024 * 1024);
    console.log('[Meshy] Segment file size:', fileSizeMB.toFixed(2), 'MB');
    
    let modelUrl;
    const publicUrl = getPublicMeshUrl(segmentMeshUrl);
    
    if (publicUrl) {
      console.log('[Meshy] Using public URL for segment:', publicUrl);
      modelUrl = publicUrl;
    } else if (fileSizeMB < 5) {
      console.log('[Meshy] Converting segment to data URI...');
      modelUrl = fileToDataUri(localMeshPath);
    } else {
      return res.status(400).json({
        success: false,
        error: 'Segment file too large and no public URL available.',
        fileSizeMB: fileSizeMB.toFixed(2),
      });
    }

    // Get public URL for the texture
    let textureStyleUrl = textureUrl;
    if (textureUrl.startsWith('/')) {
      const publicBase = process.env.NGROK_URL || process.env.PUBLIC_URL || process.env.VITE_NGROK_URL;
      if (publicBase) {
        textureStyleUrl = `${publicBase}${textureUrl}`;
        console.log('[Meshy] Converted texture to public URL:', textureStyleUrl);
      } else {
        // Try to convert local texture to data URI
        const localTexturePath = path.join(process.cwd(), 'public', textureUrl);
        if (fs.existsSync(localTexturePath)) {
          const texBuffer = fs.readFileSync(localTexturePath);
          const texExt = path.extname(localTexturePath).toLowerCase();
          const texMime = texExt === '.png' ? 'image/png' : 'image/jpeg';
          textureStyleUrl = `data:${texMime};base64,${texBuffer.toString('base64')}`;
          console.log('[Meshy] Converted texture to data URI');
        }
      }
    }

    // Build surface-specific prompt
    const surfaceDescriptions = {
      flooring: 'floor surface with the applied flooring material',
      floor: 'floor surface with the applied flooring material',
      walls: 'wall surface with the applied wall finish',
      wall: 'wall surface with the applied wall finish',
      countertops: 'countertop surface with the applied counter material',
      countertop: 'countertop surface with the applied counter material',
      ceiling: 'ceiling surface with the applied ceiling finish',
    };

    const objectDescription = surfaceDescriptions[surfaceType] || 'surface with the applied material';
    const stylePrompt = textPrompt || `Apply the reference texture image to this ${surfaceType} surface. Match the texture pattern, color, and material properties exactly.`;

    console.log('[Meshy] Object description:', objectDescription);
    console.log('[Meshy] Style prompt:', stylePrompt);

    // Build Meshy API payload
    const payload = {
      model_url: modelUrl,
      object_prompt: objectDescription,
      text_style_prompt: stylePrompt,
      image_style_url: textureStyleUrl, // The Gemini-generated texture!
      art_style: artStyle,
      enable_pbr: enablePBR,
      resolution: parseInt(resolution, 10),
      enable_original_uv: enableOriginalUV, // Preserve UV for seamless reassembly
    };

    console.log('[Meshy] Sending segment retexture request...');
    const response = await fetch(`${MESHY_API_BASE}/retexture`, {
      method: 'POST',
      headers: getMeshyHeaders(),
      body: JSON.stringify(payload),
    });

    const result = await response.json();
    console.log('[Meshy] API response:', JSON.stringify(result, null, 2));

    if (!response.ok) {
      console.error('[Meshy] API error:', result);
      return res.status(response.status).json({
        success: false,
        error: result.message || result.error || 'Meshy API error',
        details: result,
      });
    }

    // Store task info for polling
    const jobId = uuidv4();
    const taskId = result.result;
    
    activeTasks.set(jobId, {
      taskId,
      meshUrl: segmentMeshUrl,
      textureUrl,
      surfaceType,
      isSegment: true, // Mark as segment retexture
      status: 'PENDING',
      createdAt: new Date().toISOString(),
    });

    console.log('[Meshy] ✅ Segment retexture task created:', taskId);

    res.json({
      success: true,
      taskId,
      jobId,
      surfaceType,
      isSegment: true,
      message: 'Segment retexture task created. Poll /api/meshy/status/:jobId for results.',
    });

  } catch (error) {
    console.error('[Meshy] Error creating segment retexture task:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/meshy/history
 * 
 * Get list of locally saved retextured meshes
 */
router.get('/history', (req, res) => {
  try {
    if (!fs.existsSync(RETEXTURE_DIR)) {
      return res.json({ success: true, meshes: [] });
    }

    const files = fs.readdirSync(RETEXTURE_DIR);
    const meshes = files
      .filter(f => f.endsWith('.glb') || f.endsWith('.obj') || f.endsWith('.fbx'))
      .map(filename => {
        const filePath = path.join(RETEXTURE_DIR, filename);
        const stats = fs.statSync(filePath);
        
        // Look for matching thumbnail
        const baseName = filename.replace(/\.[^.]+$/, '');
        const thumbFilename = `${baseName}_thumb.png`;
        const hasThumbnail = files.includes(thumbFilename);
        
        return {
          filename,
          url: `/retextured-meshes/${filename}`,
          thumbnailUrl: hasThumbnail ? `/retextured-meshes/${thumbFilename}` : null,
          fileSize: stats.size,
          createdAt: stats.mtime.toISOString(),
        };
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json({
      success: true,
      meshes,
      count: meshes.length,
    });

  } catch (error) {
    console.error('[Meshy] Error listing history:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
