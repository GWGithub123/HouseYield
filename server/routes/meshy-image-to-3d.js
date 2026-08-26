/**
 * Meshy Image-to-3D API Routes
 * 
 * Converts images (including viewport captures) to 3D models using Meshy AI
 * Supports base64 data URIs for direct viewport screenshots
 */

import express from 'express';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Meshy API configuration
const MESHY_API_KEY = process.env.Meshy_API_Key || process.env.MESHY_API_KEY;
const MESHY_API_BASE = 'https://api.meshy.ai/openapi/v1';

// Storage directory for generated objects
const GENERATED_OBJECTS_DIR = path.join(__dirname, '..', '..', 'public', 'generated-objects');

// Ensure storage directory exists
if (!fs.existsSync(GENERATED_OBJECTS_DIR)) {
  fs.mkdirSync(GENERATED_OBJECTS_DIR, { recursive: true });
}

// Track active tasks
const activeTasks = new Map();

/**
 * POST /create
 * Create an Image-to-3D task from a captured viewport image
 * 
 * Body:
 * - imageData: base64 image data or public URL
 * - description: Text description of the object to create (optional, used for texture_prompt)
 * - options: { enable_pbr, topology, target_polycount, ai_model, should_texture, should_remesh }
 */
router.post('/create', async (req, res) => {
  try {
    const { imageData, description, options = {} } = req.body;

    if (!imageData) {
      return res.status(400).json({ error: 'imageData is required (base64 or URL)' });
    }

    if (!MESHY_API_KEY) {
      return res.status(500).json({ error: 'Meshy API key not configured' });
    }

    // Prepare image_url - if it's already a data URI, use as-is; otherwise treat as URL
    let image_url = imageData;
    if (!imageData.startsWith('data:') && !imageData.startsWith('http')) {
      // Assume it's raw base64, wrap it
      image_url = `data:image/png;base64,${imageData}`;
    }

    // Build request payload
    const payload = {
      image_url,
      enable_pbr: options.enable_pbr !== false, // Default true for realistic materials
      should_texture: options.should_texture !== false, // Default true
      should_remesh: options.should_remesh !== false, // Default true
      ai_model: options.ai_model || 'latest', // Use Meshy 6 Preview
      topology: options.topology || 'triangle',
      target_polycount: options.target_polycount || 30000,
    };

    // Add texture prompt if description provided
    if (description && description.trim()) {
      payload.texture_prompt = description.trim();
    }

    console.log(`[Image-to-3D] Creating task with ai_model: ${payload.ai_model}`);

    const response = await fetch(`${MESHY_API_BASE}/image-to-3d`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${MESHY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('[Image-to-3D] API error:', data);
      return res.status(response.status).json({ 
        error: data.message || 'Failed to create Image-to-3D task',
        details: data
      });
    }

    const taskId = data.result;
    console.log(`[Image-to-3D] Task created: ${taskId}`);

    // Track the task
    activeTasks.set(taskId, {
      id: taskId,
      type: 'image-to-3d',
      status: 'PENDING',
      progress: 0,
      description: description || 'Viewport capture',
      createdAt: Date.now(),
    });

    res.json({ 
      success: true, 
      taskId,
      message: 'Image-to-3D task created successfully'
    });

  } catch (error) {
    console.error('[Image-to-3D] Create error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /status/:taskId
 * Get the status of an Image-to-3D task
 */
router.get('/status/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params;

    if (!MESHY_API_KEY) {
      return res.status(500).json({ error: 'Meshy API key not configured' });
    }

    const response = await fetch(`${MESHY_API_BASE}/image-to-3d/${taskId}`, {
      headers: {
        'Authorization': `Bearer ${MESHY_API_KEY}`,
      },
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ 
        error: data.message || 'Failed to get task status',
        details: data
      });
    }

    // Update tracked task
    if (activeTasks.has(taskId)) {
      const tracked = activeTasks.get(taskId);
      tracked.status = data.status;
      tracked.progress = data.progress || 0;
      if (data.thumbnail_url) tracked.thumbnail_url = data.thumbnail_url;
      if (data.model_urls) tracked.model_urls = data.model_urls;
    }

    res.json({
      taskId,
      status: data.status,
      progress: data.progress || 0,
      model_urls: data.model_urls || null,
      thumbnail_url: data.thumbnail_url || null,
      texture_urls: data.texture_urls || null,
      error: data.task_error?.message || null,
    });

  } catch (error) {
    console.error('[Image-to-3D] Status error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /download/:taskId
 * Download the completed model and save locally
 */
router.post('/download/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params;
    const { format = 'glb' } = req.body;

    if (!MESHY_API_KEY) {
      return res.status(500).json({ error: 'Meshy API key not configured' });
    }

    // Get task status to get model URLs
    const statusResponse = await fetch(`${MESHY_API_BASE}/image-to-3d/${taskId}`, {
      headers: {
        'Authorization': `Bearer ${MESHY_API_KEY}`,
      },
    });

    const taskData = await statusResponse.json();

    if (!statusResponse.ok || taskData.status !== 'SUCCEEDED') {
      return res.status(400).json({ 
        error: 'Task not ready for download',
        status: taskData.status
      });
    }

    const modelUrl = taskData.model_urls?.[format];
    if (!modelUrl) {
      return res.status(400).json({ 
        error: `Model format '${format}' not available`,
        available: Object.keys(taskData.model_urls || {})
      });
    }

    // Download the model
    console.log(`[Image-to-3D] Downloading ${format} model for task ${taskId}`);
    const modelResponse = await fetch(modelUrl);
    
    if (!modelResponse.ok) {
      return res.status(500).json({ error: 'Failed to download model from Meshy' });
    }

    const modelBuffer = await modelResponse.buffer();
    
    // Generate filename based on description or task ID
    const tracked = activeTasks.get(taskId);
    const baseName = tracked?.description 
      ? tracked.description.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30)
      : `viewport_${taskId.substring(0, 8)}`;
    
    const filename = `${baseName}_${Date.now()}.${format}`;
    const filepath = path.join(GENERATED_OBJECTS_DIR, filename);
    
    fs.writeFileSync(filepath, modelBuffer);
    console.log(`[Image-to-3D] Saved model to: ${filepath}`);

    // Also download thumbnail if available
    let thumbnailPath = null;
    if (taskData.thumbnail_url) {
      try {
        const thumbResponse = await fetch(taskData.thumbnail_url);
        if (thumbResponse.ok) {
          const thumbBuffer = await thumbResponse.buffer();
          const thumbFilename = `${baseName}_${Date.now()}_thumb.png`;
          thumbnailPath = path.join(GENERATED_OBJECTS_DIR, thumbFilename);
          fs.writeFileSync(thumbnailPath, thumbBuffer);
        }
      } catch (e) {
        console.warn('[Image-to-3D] Failed to download thumbnail:', e.message);
      }
    }

    res.json({
      success: true,
      filename,
      localPath: `/generated-objects/${filename}`,
      thumbnailPath: thumbnailPath ? `/generated-objects/${path.basename(thumbnailPath)}` : null,
      format,
    });

  } catch (error) {
    console.error('[Image-to-3D] Download error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /tasks
 * List all active Image-to-3D tasks
 */
router.get('/tasks', (req, res) => {
  const tasks = Array.from(activeTasks.values())
    .filter(t => t.type === 'image-to-3d')
    .sort((a, b) => b.createdAt - a.createdAt);
  
  res.json({ tasks });
});

/**
 * GET /library
 * List downloaded viewport-generated objects
 */
router.get('/library', (req, res) => {
  try {
    if (!fs.existsSync(GENERATED_OBJECTS_DIR)) {
      return res.json({ objects: [] });
    }

    const files = fs.readdirSync(GENERATED_OBJECTS_DIR);
    const objects = files
      .filter(f => f.endsWith('.glb') || f.endsWith('.obj') || f.endsWith('.fbx'))
      .map(filename => {
        const stats = fs.statSync(path.join(GENERATED_OBJECTS_DIR, filename));
        const baseName = filename.replace(/\.[^.]+$/, '');
        const thumbnailFile = files.find(f => f.startsWith(baseName) && f.includes('_thumb.png'));
        
        return {
          filename,
          path: `/generated-objects/${filename}`,
          thumbnail: thumbnailFile ? `/generated-objects/${thumbnailFile}` : null,
          size: stats.size,
          createdAt: stats.birthtime,
          source: filename.startsWith('viewport_') ? 'viewport-capture' : 'text-prompt',
        };
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json({ objects });

  } catch (error) {
    console.error('[Image-to-3D] Library error:', error);
    res.status(500).json({ error: error.message });
  }
});

console.log('✅ [Meshy Image-to-3D] Viewport capture to 3D object routes loaded');

export default router;
