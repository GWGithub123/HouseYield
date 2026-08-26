/**
 * Meshy AI Text-to-3D API Routes
 * 
 * Provides endpoints for generating 3D objects from text prompts:
 * - Create preview tasks (generates untextured mesh)
 * - Create refine tasks (adds textures to preview)
 * - Poll for task completion
 * - Download generated models (GLB format)
 * 
 * Use case: Generate furniture and objects to place in room scans
 * e.g., Create a "modern leather sofa" to visualize in the room
 * 
 * API Reference: https://docs.meshy.ai/en/api/text-to-3d
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

const MESHY_API_BASE = 'https://api.meshy.ai/openapi/v2';
const MESHY_API_KEY = process.env.Meshy_API_Key;
const GENERATED_OBJECTS_DIR = path.join(process.cwd(), 'public', 'generated-objects');

// Ensure output directory exists
if (!fs.existsSync(GENERATED_OBJECTS_DIR)) {
  fs.mkdirSync(GENERATED_OBJECTS_DIR, { recursive: true });
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

// Store active tasks for tracking
const activeTasks = new Map();

// ============================================================================
// API Endpoints
// ============================================================================

/**
 * POST /api/meshy/text-to-3d/preview
 * 
 * Create a new Text-to-3D preview task (generates untextured mesh)
 * 
 * Request body:
 * - prompt: string - Description of the object to generate (max 600 chars)
 * - artStyle: 'realistic' | 'sculpture' - Art style (default: realistic)
 * - aiModel: 'meshy-4' | 'meshy-5' | 'latest' - AI model to use (default: latest)
 * - targetPolycount: number - Target polygon count (100-300000, default: 30000)
 * - topology: 'quad' | 'triangle' - Mesh topology (default: triangle)
 * 
 * Response:
 * - success: boolean
 * - taskId: string - Meshy task ID for polling
 * - jobId: string - Local job ID for tracking
 */
router.post('/preview', async (req, res) => {
  try {
    const {
      prompt,
      artStyle = 'realistic',
      aiModel = 'latest',
      targetPolycount = 30000,
      topology = 'triangle',
    } = req.body;

    if (!prompt) {
      return res.status(400).json({ success: false, error: 'prompt is required' });
    }

    if (prompt.length > 600) {
      return res.status(400).json({ success: false, error: 'prompt must be 600 characters or less' });
    }

    console.log('[Meshy Text-to-3D] 🎨 Creating preview task...');
    console.log('[Meshy Text-to-3D] Prompt:', prompt);
    console.log('[Meshy Text-to-3D] Art style:', artStyle);
    console.log('[Meshy Text-to-3D] AI model:', aiModel);

    // Create Meshy Text-to-3D preview task
    const payload = {
      mode: 'preview',
      prompt: prompt.substring(0, 600),
      art_style: artStyle,
      ai_model: aiModel,
      target_polycount: targetPolycount,
      topology: topology,
      should_remesh: true,
    };

    console.log('[Meshy Text-to-3D] Sending request to Meshy API...');
    const response = await fetch(`${MESHY_API_BASE}/text-to-3d`, {
      method: 'POST',
      headers: getMeshyHeaders(),
      body: JSON.stringify(payload),
    });

    const result = await response.json();
    console.log('[Meshy Text-to-3D] API response:', JSON.stringify(result, null, 2));

    if (!response.ok) {
      console.error('[Meshy Text-to-3D] API error:', result);
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
      type: 'preview',
      prompt,
      status: 'PENDING',
      createdAt: new Date().toISOString(),
    });

    console.log('[Meshy Text-to-3D] ✅ Preview task created:', taskId);

    res.json({
      success: true,
      taskId,
      jobId,
      message: 'Preview task created. Poll /api/meshy/text-to-3d/status/:jobId for results.',
    });

  } catch (error) {
    console.error('[Meshy Text-to-3D] Error creating preview task:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/meshy/text-to-3d/refine
 * 
 * Create a refine task to add textures to a preview model
 * 
 * Request body:
 * - previewTaskId: string - The preview task ID to refine
 * - enablePBR: boolean - Generate PBR maps (default: true)
 * - texturePrompt: string - Optional prompt for texturing
 * 
 * Response:
 * - success: boolean
 * - taskId: string - Meshy task ID for polling
 * - jobId: string - Local job ID for tracking
 */
router.post('/refine', async (req, res) => {
  try {
    const {
      previewTaskId,
      enablePBR = true,
      texturePrompt,
      aiModel = 'latest',
    } = req.body;

    if (!previewTaskId) {
      return res.status(400).json({ success: false, error: 'previewTaskId is required' });
    }

    console.log('[Meshy Text-to-3D] 🎨 Creating refine task...');
    console.log('[Meshy Text-to-3D] Preview task ID:', previewTaskId);
    console.log('[Meshy Text-to-3D] Enable PBR:', enablePBR);

    // Create Meshy Text-to-3D refine task
    const payload = {
      mode: 'refine',
      preview_task_id: previewTaskId,
      enable_pbr: enablePBR,
      ai_model: aiModel,
    };

    if (texturePrompt) {
      payload.texture_prompt = texturePrompt.substring(0, 600);
    }

    console.log('[Meshy Text-to-3D] Sending refine request to Meshy API...');
    const response = await fetch(`${MESHY_API_BASE}/text-to-3d`, {
      method: 'POST',
      headers: getMeshyHeaders(),
      body: JSON.stringify(payload),
    });

    const result = await response.json();
    console.log('[Meshy Text-to-3D] API response:', JSON.stringify(result, null, 2));

    if (!response.ok) {
      console.error('[Meshy Text-to-3D] API error:', result);
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
      type: 'refine',
      previewTaskId,
      status: 'PENDING',
      createdAt: new Date().toISOString(),
    });

    console.log('[Meshy Text-to-3D] ✅ Refine task created:', taskId);

    res.json({
      success: true,
      taskId,
      jobId,
      message: 'Refine task created. Poll /api/meshy/text-to-3d/status/:jobId for results.',
    });

  } catch (error) {
    console.error('[Meshy Text-to-3D] Error creating refine task:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/meshy/text-to-3d/status/:jobId
 * 
 * Check the status of a Text-to-3D task
 */
router.get('/status/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    
    const taskInfo = activeTasks.get(jobId);
    if (!taskInfo) {
      return res.status(404).json({
        success: false,
        error: 'Task not found',
      });
    }

    // Fetch current status from Meshy
    const response = await fetch(`${MESHY_API_BASE}/text-to-3d/${taskInfo.taskId}`, {
      method: 'GET',
      headers: getMeshyHeaders(),
    });

    const result = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        success: false,
        error: result.message || 'Failed to get task status',
      });
    }

    // Update stored status
    taskInfo.status = result.status;
    taskInfo.progress = result.progress;
    activeTasks.set(jobId, taskInfo);

    const responseData = {
      success: true,
      jobId,
      taskId: taskInfo.taskId,
      type: taskInfo.type,
      status: result.status,
      progress: result.progress || 0,
      prompt: result.prompt,
      thumbnailUrl: result.thumbnail_url,
    };

    // Include model URLs if task succeeded
    if (result.status === 'SUCCEEDED' && result.model_urls) {
      responseData.modelUrls = result.model_urls;
      responseData.textureUrls = result.texture_urls;
    }

    // Include error if task failed
    if (result.status === 'FAILED' && result.task_error) {
      responseData.error = result.task_error.message;
    }

    res.json(responseData);

  } catch (error) {
    console.error('[Meshy Text-to-3D] Error checking status:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/meshy/text-to-3d/download/:jobId
 * 
 * Download the generated model and save locally
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

    // Fetch current status to get model URLs
    console.log('[Meshy Text-to-3D] 📥 Fetching model URLs for download...');
    const statusResponse = await fetch(`${MESHY_API_BASE}/text-to-3d/${taskInfo.taskId}`, {
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
    console.log('[Meshy Text-to-3D] Downloading from:', modelUrl);

    // Download the model
    const downloadResponse = await fetch(modelUrl);
    if (!downloadResponse.ok) {
      throw new Error(`Failed to download model: ${downloadResponse.status}`);
    }

    const buffer = await downloadResponse.buffer();
    
    // Create a sanitized filename from the prompt
    const sanitizedPrompt = (taskInfo.prompt || statusResult.prompt || 'object')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .substring(0, 30);
    
    const timestamp = Date.now();
    const filename = `${sanitizedPrompt}_${timestamp}.${format}`;
    const localPath = path.join(GENERATED_OBJECTS_DIR, filename);
    
    fs.writeFileSync(localPath, buffer);
    console.log('[Meshy Text-to-3D] ✅ Model saved to:', localPath);

    // Download thumbnail if available
    let thumbnailLocalUrl = null;
    if (statusResult.thumbnail_url) {
      try {
        const thumbResponse = await fetch(statusResult.thumbnail_url);
        if (thumbResponse.ok) {
          const thumbBuffer = await thumbResponse.buffer();
          const thumbFilename = `${sanitizedPrompt}_${timestamp}_thumb.png`;
          const thumbPath = path.join(GENERATED_OBJECTS_DIR, thumbFilename);
          fs.writeFileSync(thumbPath, thumbBuffer);
          thumbnailLocalUrl = `/generated-objects/${thumbFilename}`;
        }
      } catch (thumbError) {
        console.warn('[Meshy Text-to-3D] Failed to download thumbnail:', thumbError.message);
      }
    }

    res.json({
      success: true,
      localUrl: `/generated-objects/${filename}`,
      thumbnailUrl: thumbnailLocalUrl,
      format,
      fileSize: buffer.length,
      prompt: statusResult.prompt,
    });

  } catch (error) {
    console.error('[Meshy Text-to-3D] Error downloading model:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/meshy/text-to-3d/tasks
 * 
 * Get list of active tasks
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
    tasks: tasks.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
    count: tasks.length,
  });
});

/**
 * GET /api/meshy/text-to-3d/library
 * 
 * Get list of previously generated objects
 */
router.get('/library', (req, res) => {
  try {
    const files = fs.readdirSync(GENERATED_OBJECTS_DIR);
    const objects = [];
    
    for (const file of files) {
      if (file.endsWith('.glb') || file.endsWith('.obj') || file.endsWith('.fbx')) {
        const stats = fs.statSync(path.join(GENERATED_OBJECTS_DIR, file));
        const baseName = file.replace(/\.[^.]+$/, '');
        const thumbFile = `${baseName}_thumb.png`;
        const hasThumb = files.includes(thumbFile);
        
        objects.push({
          filename: file,
          url: `/generated-objects/${file}`,
          thumbnailUrl: hasThumb ? `/generated-objects/${thumbFile}` : null,
          createdAt: stats.mtime.toISOString(),
          fileSize: stats.size,
        });
      }
    }
    
    res.json({
      success: true,
      objects: objects.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
      count: objects.length,
    });
    
  } catch (error) {
    console.error('[Meshy Text-to-3D] Error listing library:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * DELETE /api/meshy/text-to-3d/library/:filename
 * 
 * Delete an object from the library
 */
router.delete('/library/:filename', (req, res) => {
  try {
    const { filename } = req.params;
    const filePath = path.join(GENERATED_OBJECTS_DIR, filename);
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        error: 'File not found',
      });
    }
    
    fs.unlinkSync(filePath);
    
    // Also delete thumbnail if exists
    const baseName = filename.replace(/\.[^.]+$/, '');
    const thumbPath = path.join(GENERATED_OBJECTS_DIR, `${baseName}_thumb.png`);
    if (fs.existsSync(thumbPath)) {
      fs.unlinkSync(thumbPath);
    }
    
    res.json({
      success: true,
      message: 'Object deleted',
    });
    
  } catch (error) {
    console.error('[Meshy Text-to-3D] Error deleting object:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
