/**
 * Meshy Image-to-Image API Routes
 * 
 * Uses Nano Banana Pro to generate concept images from:
 * - Reference images (room context, existing furniture, etc.)
 * - Text prompts (describing what to generate/transform)
 * 
 * This is perfect for renovation planning where you need to:
 * - Show the AI what the room looks like
 * - Describe the object you want to add/modify
 * - Get a realistic concept image that fits the room context
 */

import express from 'express';
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
const CONCEPT_IMAGES_DIR = path.join(__dirname, '../../public/renovation-concepts');

// Ensure directory exists
if (!fs.existsSync(CONCEPT_IMAGES_DIR)) {
  fs.mkdirSync(CONCEPT_IMAGES_DIR, { recursive: true });
}

/**
 * POST /create
 * Create an Image-to-Image task using room context + text prompt
 * 
 * This allows the AI to understand the visual context of the room
 * while generating objects that will fit naturally
 */
router.post('/create', async (req, res) => {
  try {
    const apiKey = getApiKey();
    if (!apiKey) {
      return res.status(500).json({ error: 'Meshy API key not configured' });
    }

    const {
      reference_image_urls, // Array of 1-5 reference images (room photos, etc.)
      prompt,               // Text description of what to generate
      ai_model = 'nano-banana-pro',
      generate_multi_view = false,
      // Dimension metadata (stored locally, not sent to Meshy)
      dimensions = null     // { width, height, depth, unit: 'inches' | 'cm' | 'meters' }
    } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    if (!reference_image_urls || !Array.isArray(reference_image_urls) || reference_image_urls.length === 0) {
      return res.status(400).json({ error: 'At least one reference image URL is required' });
    }

    if (reference_image_urls.length > 5) {
      return res.status(400).json({ error: 'Maximum 5 reference images allowed' });
    }

    const payload = {
      ai_model,
      prompt,
      reference_image_urls,
    };

    if (generate_multi_view) {
      payload.generate_multi_view = true;
    }

    console.log('[Image-to-Image] Creating task with', reference_image_urls.length, 'reference images');
    console.log('[Image-to-Image] Prompt:', prompt.substring(0, 100) + '...');

    const response = await fetch(`${MESHY_API_URL}/image-to-image`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('[Image-to-Image] API error:', errorData);
      return res.status(response.status).json({ 
        error: errorData.message || `API error: ${response.status}` 
      });
    }

    const data = await response.json();
    console.log('[Image-to-Image] Task created:', data.result);

    // Store dimension metadata if provided
    if (dimensions) {
      const metadataPath = path.join(CONCEPT_IMAGES_DIR, `${data.result}_dimensions.json`);
      fs.writeFileSync(metadataPath, JSON.stringify({
        taskId: data.result,
        dimensions,
        prompt,
        createdAt: new Date().toISOString()
      }, null, 2));
      console.log('[Image-to-Image] Stored dimension metadata:', dimensions);
    }

    res.json({
      taskId: data.result,
      message: 'Image-to-Image task created successfully',
      dimensions: dimensions || null
    });

  } catch (error) {
    console.error('[Image-to-Image] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /status/:taskId
 * Get the status of an Image-to-Image task
 */
router.get('/status/:taskId', async (req, res) => {
  try {
    const apiKey = getApiKey();
    if (!apiKey) {
      return res.status(500).json({ error: 'Meshy API key not configured' });
    }

    const { taskId } = req.params;

    const response = await fetch(`${MESHY_API_URL}/image-to-image/${taskId}`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return res.status(response.status).json({ 
        error: errorData.message || `API error: ${response.status}` 
      });
    }

    const data = await response.json();

    // Include stored dimension metadata if available
    const metadataPath = path.join(CONCEPT_IMAGES_DIR, `${taskId}_dimensions.json`);
    let dimensions = null;
    if (fs.existsSync(metadataPath)) {
      const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
      dimensions = metadata.dimensions;
    }

    res.json({ ...data, dimensions });

  } catch (error) {
    console.error('[Image-to-Image] Status error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /download/:taskId
 * Download generated concept image(s) to local storage with dimension metadata
 */
router.post('/download/:taskId', async (req, res) => {
  try {
    const apiKey = getApiKey();
    if (!apiKey) {
      return res.status(500).json({ error: 'Meshy API key not configured' });
    }

    const { taskId } = req.params;

    // Get task status
    const statusResponse = await fetch(`${MESHY_API_URL}/image-to-image/${taskId}`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });

    if (!statusResponse.ok) {
      const errorData = await statusResponse.json().catch(() => ({}));
      return res.status(statusResponse.status).json({ 
        error: errorData.message || 'Failed to get task status' 
      });
    }

    const taskData = await statusResponse.json();

    if (taskData.status !== 'SUCCEEDED') {
      return res.status(400).json({
        error: 'Task not complete yet',
        status: taskData.status,
        progress: taskData.progress
      });
    }

    const imageUrls = taskData.image_urls;
    if (!imageUrls || imageUrls.length === 0) {
      return res.status(400).json({ error: 'No images available' });
    }

    // Load dimension metadata if exists
    const metadataPath = path.join(CONCEPT_IMAGES_DIR, `${taskId}_dimensions.json`);
    let dimensions = null;
    if (fs.existsSync(metadataPath)) {
      const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
      dimensions = metadata.dimensions;
    }

    const downloadedImages = [];

    // Download each image
    for (let i = 0; i < imageUrls.length; i++) {
      const imageUrl = imageUrls[i];
      const imageResponse = await fetch(imageUrl);
      const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());

      // Generate filename
      const prompt = taskData.prompt || 'concept';
      const sanitizedPrompt = prompt
        .replace(/[^a-zA-Z0-9\s]/g, '')
        .replace(/\s+/g, '_')
        .substring(0, 30);

      const suffix = imageUrls.length > 1 ? `_view${i + 1}` : '';
      const filename = `${sanitizedPrompt}${suffix}_${Date.now()}.png`;
      const filePath = path.join(CONCEPT_IMAGES_DIR, filename);

      fs.writeFileSync(filePath, imageBuffer);
      console.log('[Image-to-Image] Saved:', filename);

      // Save per-image metadata including dimensions
      const imageMetadata = {
        filename,
        taskId,
        prompt: taskData.prompt,
        dimensions,
        createdAt: new Date().toISOString(),
        originalUrl: imageUrl
      };
      
      const imageMetadataPath = path.join(CONCEPT_IMAGES_DIR, `${path.basename(filename, '.png')}_meta.json`);
      fs.writeFileSync(imageMetadataPath, JSON.stringify(imageMetadata, null, 2));

      downloadedImages.push({
        filename,
        path: `/renovation-concepts/${filename}`,
        dimensions,
        originalUrl: imageUrl
      });
    }

    res.json({
      message: 'Concept image(s) downloaded successfully',
      images: downloadedImages,
      prompt: taskData.prompt,
      dimensions
    });

  } catch (error) {
    console.error('[Image-to-Image] Download error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /library
 * Get list of saved renovation concept images with dimension metadata
 */
router.get('/library', async (req, res) => {
  try {
    if (!fs.existsSync(CONCEPT_IMAGES_DIR)) {
      return res.json({ images: [] });
    }

    const files = fs.readdirSync(CONCEPT_IMAGES_DIR);
    const images = [];

    for (const filename of files) {
      if (!filename.endsWith('.png') && !filename.endsWith('.jpg') && !filename.endsWith('.jpeg')) {
        continue;
      }

      const filePath = path.join(CONCEPT_IMAGES_DIR, filename);
      const stats = fs.statSync(filePath);

      // Try to load metadata
      const metaFilename = `${path.basename(filename, path.extname(filename))}_meta.json`;
      const metaPath = path.join(CONCEPT_IMAGES_DIR, metaFilename);
      
      let metadata = null;
      if (fs.existsSync(metaPath)) {
        metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      }

      images.push({
        filename,
        path: `/renovation-concepts/${filename}`,
        size: stats.size,
        createdAt: stats.birthtime,
        dimensions: metadata?.dimensions || null,
        prompt: metadata?.prompt || null
      });
    }

    // Sort by creation date, newest first
    images.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json({ images });

  } catch (error) {
    console.error('[Image-to-Image] Library error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /renovation-pipeline
 * Full renovation object generation pipeline:
 * 1. Take room context image + object description + dimensions
 * 2. Generate concept image with Nano Banana Pro
 * 3. Convert to 3D model with Image-to-3D
 * 4. Apply dimension scaling for accurate renovation planning
 */
router.post('/renovation-pipeline', async (req, res) => {
  try {
    const apiKey = getApiKey();
    if (!apiKey) {
      return res.status(500).json({ error: 'Meshy API key not configured' });
    }

    const {
      room_image,          // Base64 or URL of the room
      object_description,  // What object to generate
      dimensions,          // { width, height, depth, unit }
      placement_context,   // Optional: "against the wall", "in the corner", etc.
      style_preferences,   // Optional: "modern", "rustic", etc.
      generate_multi_view = true  // Generate multiple views for better 3D
    } = req.body;

    if (!room_image) {
      return res.status(400).json({ error: 'Room image is required' });
    }

    if (!object_description) {
      return res.status(400).json({ error: 'Object description is required' });
    }

    if (!dimensions || !dimensions.width || !dimensions.height || !dimensions.depth) {
      return res.status(400).json({ 
        error: 'Dimensions are required (width, height, depth)' 
      });
    }

    // Build an optimized prompt that includes dimension context
    const dimensionText = `${dimensions.width}${dimensions.unit || 'inches'} wide, ${dimensions.height}${dimensions.unit || 'inches'} tall, ${dimensions.depth}${dimensions.unit || 'inches'} deep`;
    
    let enhancedPrompt = `Generate a photorealistic ${object_description}, ${dimensionText}`;
    
    if (style_preferences) {
      enhancedPrompt += `, ${style_preferences} style`;
    }
    
    if (placement_context) {
      enhancedPrompt += `, positioned ${placement_context}`;
    }
    
    enhancedPrompt += `, product photography, isolated on white background, clear details, 3D render ready, accurate proportions`;

    console.log('[Renovation Pipeline] Starting with prompt:', enhancedPrompt);

    // Step 1: Create Image-to-Image task
    const imageTaskPayload = {
      ai_model: 'nano-banana-pro',
      prompt: enhancedPrompt,
      reference_image_urls: [room_image],
      generate_multi_view
    };

    const imageResponse = await fetch(`${MESHY_API_URL}/image-to-image`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(imageTaskPayload)
    });

    if (!imageResponse.ok) {
      const errorData = await imageResponse.json().catch(() => ({}));
      return res.status(imageResponse.status).json({ 
        error: errorData.message || 'Failed to create image task' 
      });
    }

    const imageData = await imageResponse.json();
    const imageTaskId = imageData.result;

    // Store dimension metadata
    const metadataPath = path.join(CONCEPT_IMAGES_DIR, `${imageTaskId}_dimensions.json`);
    fs.writeFileSync(metadataPath, JSON.stringify({
      taskId: imageTaskId,
      dimensions,
      prompt: enhancedPrompt,
      object_description,
      placement_context,
      style_preferences,
      createdAt: new Date().toISOString()
    }, null, 2));

    res.json({
      message: 'Renovation pipeline started',
      imageTaskId,
      stage: 'generating-concept',
      dimensions,
      enhancedPrompt
    });

  } catch (error) {
    console.error('[Renovation Pipeline] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /apply-dimensions/:taskId
 * Apply exact dimensions to a generated 3D model
 * This calculates the scale factor needed to match real-world dimensions
 */
router.post('/apply-dimensions/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params;
    const {
      dimensions,              // { width, height, depth, unit }
      model_bounding_box = null // Optional: actual bounding box from Three.js
    } = req.body;

    if (!dimensions) {
      return res.status(400).json({ error: 'Dimensions are required' });
    }

    // Convert all dimensions to meters (Three.js default unit)
    const toMeters = (value, unit) => {
      switch (unit) {
        case 'inches': return value * 0.0254;
        case 'cm': return value * 0.01;
        case 'feet': return value * 0.3048;
        case 'meters': return value;
        default: return value * 0.0254; // Default to inches
      }
    };

    const targetDimensions = {
      width: toMeters(dimensions.width, dimensions.unit || 'inches'),
      height: toMeters(dimensions.height, dimensions.unit || 'inches'),
      depth: toMeters(dimensions.depth, dimensions.unit || 'inches')
    };

    // Calculate scale factors if model bounding box is provided
    let scaleFactors = null;
    if (model_bounding_box) {
      scaleFactors = {
        x: targetDimensions.width / model_bounding_box.width,
        y: targetDimensions.height / model_bounding_box.height,
        z: targetDimensions.depth / model_bounding_box.depth,
        // Uniform scale (use the average for consistent proportions)
        uniform: (
          (targetDimensions.width / model_bounding_box.width) +
          (targetDimensions.height / model_bounding_box.height) +
          (targetDimensions.depth / model_bounding_box.depth)
        ) / 3
      };
    }

    // Store the dimension application metadata
    const dimensionMetaPath = path.join(CONCEPT_IMAGES_DIR, `${taskId}_applied_dimensions.json`);
    fs.writeFileSync(dimensionMetaPath, JSON.stringify({
      taskId,
      originalDimensions: dimensions,
      targetDimensionsMeters: targetDimensions,
      scaleFactors,
      appliedAt: new Date().toISOString()
    }, null, 2));

    res.json({
      message: 'Dimensions applied successfully',
      targetDimensionsMeters: targetDimensions,
      scaleFactors,
      // Material estimation helpers
      estimations: {
        surfaceAreaSqMeters: 2 * (
          targetDimensions.width * targetDimensions.height +
          targetDimensions.height * targetDimensions.depth +
          targetDimensions.width * targetDimensions.depth
        ),
        volumeCubicMeters: targetDimensions.width * targetDimensions.height * targetDimensions.depth,
        // Convert to common units
        surfaceAreaSqFeet: 2 * (
          targetDimensions.width * targetDimensions.height +
          targetDimensions.height * targetDimensions.depth +
          targetDimensions.width * targetDimensions.depth
        ) * 10.764,
        volumeCubicFeet: targetDimensions.width * targetDimensions.height * targetDimensions.depth * 35.315
      }
    });

  } catch (error) {
    console.error('[Apply Dimensions] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

export default router;
