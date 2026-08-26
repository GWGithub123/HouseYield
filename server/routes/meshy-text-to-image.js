/**
 * Meshy Text-to-Image API Routes
 * Uses Nano Banana Pro to generate concept images from text descriptions
 * These images can then be fed into Image-to-3D for high-quality 3D generation
 */

import express from 'express';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

const MESHY_API_URL = 'https://api.meshy.ai/openapi/v1';

// Helper to get API key
function getApiKey() {
  return process.env.Meshy_API_Key || process.env.MESHY_API_KEY;
}

// Directory for saving concept images
const CONCEPT_IMAGES_DIR = path.join(__dirname, '../../public/concept-images');

// Ensure concept images directory exists
if (!fs.existsSync(CONCEPT_IMAGES_DIR)) {
  fs.mkdirSync(CONCEPT_IMAGES_DIR, { recursive: true });
}

/**
 * POST /create
 * Create a Text-to-Image task using Nano Banana or Nano Banana Pro
 */
router.post('/create', async (req, res) => {
  try {
    const apiKey = getApiKey();
    if (!apiKey) {
      return res.status(500).json({ error: 'Meshy API key not configured' });
    }

    const { 
      prompt,
      ai_model = 'nano-banana-pro', // Default to Pro for better quality
      aspect_ratio = '1:1',
      generate_multi_view = false,
      pose_mode = null
    } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    const payload = {
      ai_model,
      prompt,
      aspect_ratio
    };

    // Add optional parameters
    if (generate_multi_view) {
      payload.generate_multi_view = true;
      delete payload.aspect_ratio; // Can't use aspect_ratio with multi-view
    }

    if (pose_mode) {
      payload.pose_mode = pose_mode;
    }

    console.log('Creating Text-to-Image task:', JSON.stringify(payload, null, 2));

    const response = await axios.post(
      `${MESHY_API_URL}/text-to-image`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('Text-to-Image task created:', response.data);
    res.json({ 
      taskId: response.data.result,
      message: 'Text-to-Image task created successfully'
    });

  } catch (error) {
    console.error('Error creating Text-to-Image task:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({ 
      error: error.response?.data?.message || error.message 
    });
  }
});

/**
 * GET /status/:taskId
 * Get the status of a Text-to-Image task
 */
router.get('/status/:taskId', async (req, res) => {
  try {
    const apiKey = getApiKey();
    if (!apiKey) {
      return res.status(500).json({ error: 'Meshy API key not configured' });
    }

    const { taskId } = req.params;

    const response = await axios.get(
      `${MESHY_API_URL}/text-to-image/${taskId}`,
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`
        }
      }
    );

    res.json(response.data);

  } catch (error) {
    console.error('Error getting Text-to-Image status:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({ 
      error: error.response?.data?.message || error.message 
    });
  }
});

/**
 * POST /download/:taskId
 * Download generated concept image(s) to local storage
 */
router.post('/download/:taskId', async (req, res) => {
  try {
    const apiKey = getApiKey();
    if (!apiKey) {
      return res.status(500).json({ error: 'Meshy API key not configured' });
    }

    const { taskId } = req.params;

    // First get the task status to get image URLs
    const statusResponse = await axios.get(
      `${MESHY_API_URL}/text-to-image/${taskId}`,
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`
        }
      }
    );

    if (statusResponse.data.status !== 'SUCCEEDED') {
      return res.status(400).json({ 
        error: 'Task not complete yet',
        status: statusResponse.data.status
      });
    }

    const imageUrls = statusResponse.data.image_urls;
    if (!imageUrls || imageUrls.length === 0) {
      return res.status(400).json({ error: 'No images available' });
    }

    const downloadedImages = [];

    // Download each image
    for (let i = 0; i < imageUrls.length; i++) {
      const imageUrl = imageUrls[i];
      const imageResponse = await axios.get(imageUrl, { 
        responseType: 'arraybuffer' 
      });

      // Generate filename from prompt (sanitized) + timestamp
      const prompt = statusResponse.data.prompt || 'concept';
      const sanitizedPrompt = prompt
        .replace(/[^a-zA-Z0-9\s]/g, '')
        .replace(/\s+/g, '_')
        .substring(0, 40);
      
      const suffix = imageUrls.length > 1 ? `_view${i + 1}` : '';
      const filename = `${sanitizedPrompt}${suffix}_${Date.now()}.png`;
      const filePath = path.join(CONCEPT_IMAGES_DIR, filename);

      fs.writeFileSync(filePath, imageResponse.data);
      console.log('Concept image saved:', filePath);

      downloadedImages.push({
        filename,
        path: `/concept-images/${filename}`,
        originalUrl: imageUrl
      });
    }

    res.json({ 
      message: 'Concept image(s) downloaded successfully',
      images: downloadedImages,
      prompt: statusResponse.data.prompt,
      ai_model: statusResponse.data.ai_model
    });

  } catch (error) {
    console.error('Error downloading concept image:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({ 
      error: error.response?.data?.message || error.message 
    });
  }
});

/**
 * GET /tasks
 * List all Text-to-Image tasks
 */
router.get('/tasks', async (req, res) => {
  try {
    const apiKey = getApiKey();
    if (!apiKey) {
      return res.status(500).json({ error: 'Meshy API key not configured' });
    }

    const { page_num = 1, page_size = 20 } = req.query;

    const response = await axios.get(
      `${MESHY_API_URL}/text-to-image`,
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`
        },
        params: {
          page_num,
          page_size,
          sort_by: '-created_at'
        }
      }
    );

    res.json(response.data);

  } catch (error) {
    console.error('Error listing Text-to-Image tasks:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({ 
      error: error.response?.data?.message || error.message 
    });
  }
});

/**
 * GET /library
 * Get locally saved concept images
 */
router.get('/library', async (req, res) => {
  try {
    if (!fs.existsSync(CONCEPT_IMAGES_DIR)) {
      return res.json({ images: [] });
    }

    const files = fs.readdirSync(CONCEPT_IMAGES_DIR);
    const images = files
      .filter(f => f.endsWith('.png') || f.endsWith('.jpg') || f.endsWith('.jpeg'))
      .map(filename => {
        const filePath = path.join(CONCEPT_IMAGES_DIR, filename);
        const stats = fs.statSync(filePath);
        return {
          filename,
          path: `/concept-images/${filename}`,
          size: stats.size,
          createdAt: stats.birthtime
        };
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json({ images });

  } catch (error) {
    console.error('Error listing concept images:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /library/:filename
 * Delete a concept image from local storage
 */
router.delete('/library/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    const filePath = path.join(CONCEPT_IMAGES_DIR, filename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Image not found' });
    }

    fs.unlinkSync(filePath);
    res.json({ message: 'Image deleted successfully' });

  } catch (error) {
    console.error('Error deleting concept image:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /concept-to-3d
 * Full pipeline: Generate concept image, then convert to 3D
 * This orchestrates the complete workflow
 */
router.post('/concept-to-3d', async (req, res) => {
  try {
    const apiKey = getApiKey();
    if (!apiKey) {
      return res.status(500).json({ error: 'Meshy API key not configured' });
    }

    const {
      prompt,
      ai_model = 'nano-banana-pro',
      aspect_ratio = '1:1',
      generate_multi_view = false,
      // Image-to-3D options for the second stage
      enable_pbr = true,
      should_texture = true,
      ai_model_3d = 'latest',
      topology = 'triangle',
      target_polycount = 30000
    } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    // Step 1: Create Text-to-Image task
    console.log('Step 1: Creating concept image with', ai_model);
    
    const textToImagePayload = {
      ai_model,
      prompt
    };

    if (generate_multi_view) {
      textToImagePayload.generate_multi_view = true;
    } else {
      textToImagePayload.aspect_ratio = aspect_ratio;
    }

    const imageTaskResponse = await axios.post(
      `${MESHY_API_URL}/text-to-image`,
      textToImagePayload,
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const imageTaskId = imageTaskResponse.data.result;
    console.log('Concept image task created:', imageTaskId);

    // Return immediately with task IDs - client will poll for progress
    res.json({
      message: 'Concept-to-3D pipeline started',
      imageTaskId,
      stage: 'generating-image',
      config: {
        prompt,
        ai_model,
        image_to_3d_options: {
          enable_pbr,
          should_texture,
          ai_model_3d,
          topology,
          target_polycount
        }
      }
    });

  } catch (error) {
    console.error('Error starting Concept-to-3D pipeline:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({ 
      error: error.response?.data?.message || error.message 
    });
  }
});

/**
 * POST /image-to-3d-from-url
 * Create Image-to-3D task using a concept image URL
 * This is step 2 of the concept-to-3D pipeline
 */
router.post('/image-to-3d-from-url', async (req, res) => {
  try {
    const apiKey = getApiKey();
    if (!apiKey) {
      return res.status(500).json({ error: 'Meshy API key not configured' });
    }

    const {
      image_url,
      enable_pbr = true,
      should_texture = true,
      should_remesh = true,
      ai_model = 'latest',
      topology = 'triangle',
      target_polycount = 30000,
      texture_prompt = ''
    } = req.body;

    if (!image_url) {
      return res.status(400).json({ error: 'image_url is required' });
    }

    const payload = {
      image_url,
      enable_pbr,
      should_texture,
      should_remesh,
      ai_model,
      topology,
      target_polycount
    };

    if (texture_prompt) {
      payload.texture_prompt = texture_prompt;
    }

    console.log('Creating Image-to-3D task from concept image URL');

    const response = await axios.post(
      `${MESHY_API_URL}/image-to-3d`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('Image-to-3D task created:', response.data);
    res.json({ 
      taskId: response.data.result,
      message: 'Image-to-3D task created from concept image'
    });

  } catch (error) {
    console.error('Error creating Image-to-3D from URL:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({ 
      error: error.response?.data?.message || error.message 
    });
  }
});

export default router;
