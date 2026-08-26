/**
 * Floor Overlay Generation API
 * 
 * A simpler approach to renovation visualization:
 * 1. Capture room from multiple angles (top-down + sides)
 * 2. Have Gemini generate the floor with new material (understanding room context)
 * 3. Send to Meshy Image-to-3D to create a 3D floor mesh
 * 4. Return mesh URL + placement info for positioning in scene
 * 
 * This bypasses complex mesh segmentation entirely!
 */

import express from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.Gemini_API_Key || process.env.GEMINI_API_KEY);

// Meshy API
const MESHY_API_KEY = process.env.MESHY_API_KEY || process.env.Meshy_API_Key;
const MESHY_API_URL = 'https://api.meshy.ai';

// Output directories
const FLOOR_IMAGES_DIR = path.join(process.cwd(), 'public', 'floor-overlays');
const FLOOR_MODELS_DIR = path.join(process.cwd(), 'public', 'floor-models');

// Ensure directories exist
[FLOOR_IMAGES_DIR, FLOOR_MODELS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Material prompts for floor generation
const FLOOR_MATERIALS = {
  'oak-hardwood': 'warm oak hardwood floor planks with natural grain and subtle knots, matte finish',
  'walnut-hardwood': 'rich dark walnut hardwood floor with deep brown tones and natural grain variation',
  'light-maple': 'light blonde maple hardwood flooring, clean modern appearance with subtle grain',
  'herringbone-parquet': 'classic herringbone pattern parquet flooring in medium oak wood',
  'white-oak-wide-plank': 'wide plank white oak flooring, light natural color with rustic farmhouse style',
  'gray-vinyl-plank': 'modern gray luxury vinyl plank flooring with contemporary wood-look pattern',
  'marble-tile': 'white Carrara marble tile floor with elegant gray veining, polished surface',
  'slate-tile': 'natural slate tile flooring in gray with subtle color variation and texture',
  'concrete-polished': 'polished concrete floor, smooth industrial gray surface',
  'terracotta-tile': 'terracotta clay tile flooring in warm Mediterranean earth tones',
};

/**
 * Generate a floor image using Gemini that matches the room's shape and lighting
 */
async function generateFloorImage(viewportImages, materialDescription, roomContext) {
  console.log('[FloorOverlay] Generating floor image with Gemini...');
  console.log('[FloorOverlay] Material:', materialDescription);
  console.log('[FloorOverlay] Viewport images:', viewportImages.length);
  
  const model = genAI.getGenerativeModel({ 
    model: 'gemini-2.5-flash-image',
    generationConfig: {
      responseModalities: ['Text', 'Image'],
    }
  });
  
  // Prepare image parts from viewport captures
  const imageParts = viewportImages.map((img, i) => {
    // Remove data URL prefix if present
    const base64Data = img.replace(/^data:image\/\w+;base64,/, '');
    return {
      inlineData: {
        mimeType: 'image/png',
        data: base64Data
      }
    };
  });
  
  // Build the prompt - Generate a standalone floor panel that Meshy can convert to 3D
  const prompt = `You are looking at a 3D scan of a room. I want you to create a new floor for this room.

ROOM CONTEXT:
${roomContext || 'This is an interior room scan.'}

NEW FLOORING MATERIAL:
${materialDescription}

IMPORTANT INSTRUCTIONS:
1. Generate an image of a STANDALONE floor panel/section floating in empty space
2. View it at a slight 3D ANGLE (not top-down) so I can see it has dimension/thickness
3. The floor panel should be ISOLATED - just the flooring by itself, NOT inside the room
4. Make it a rectangular floor section with the specified material applied
5. The flooring pattern should look like a real floor section you'd see at a showroom
6. Include subtle edge/thickness to show it's a 3D floor panel
7. Clean background (white, gray, or gradient) behind the floating floor panel
8. Realistic lighting and shadows on the floor panel
9. The wood planks or tiles should be properly scaled and oriented

Think of it like taking the floor pattern out of the room and showing me just the standalone flooring piece floating in space, viewed at an angle so I can see its surface.

Generate this standalone floor panel image now.`;

  try {
    const result = await model.generateContent([prompt, ...imageParts]);
    const response = result.response;
    
    // Extract image from response
    for (const part of response.candidates[0].content.parts) {
      if (part.inlineData) {
        console.log('[FloorOverlay] ✅ Floor image generated');
        return {
          imageData: part.inlineData.data,
          mimeType: part.inlineData.mimeType || 'image/png'
        };
      }
    }
    
    // No image in response
    console.log('[FloorOverlay] ⚠️ No image in Gemini response');
    const textResponse = response.text();
    console.log('[FloorOverlay] Text response:', textResponse.substring(0, 200));
    return null;
    
  } catch (error) {
    console.error('[FloorOverlay] Gemini error:', error);
    throw error;
  }
}

/**
 * Send floor image to Meshy Image-to-3D to create a 3D floor mesh
 */
async function createFloor3D(floorImageUrl, materialDescription) {
  console.log('[FloorOverlay] Creating 3D floor mesh with Meshy Image-to-3D...');
  
  if (!MESHY_API_KEY) {
    throw new Error('MESHY_API_KEY not configured');
  }
  
  // Create Image-to-3D task
  const createResponse = await fetch(`${MESHY_API_URL}/openapi/v1/image-to-3d`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${MESHY_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      image_url: floorImageUrl,
      enable_pbr: true,
      should_remesh: true,
      topology: 'quad', // Better for flat surfaces
      target_polycount: 10000, // Keep it simple for a floor
    })
  });
  
  const createResult = await createResponse.json();
  
  if (!createResult.result) {
    console.error('[FloorOverlay] Meshy create failed:', createResult);
    throw new Error(createResult.message || 'Failed to create Image-to-3D task');
  }
  
  const taskId = createResult.result;
  console.log('[FloorOverlay] Meshy task created:', taskId);
  
  // Poll for completion
  let status = 'PENDING';
  let result = null;
  const maxAttempts = 60; // 5 minutes max
  let attempts = 0;
  
  while (status !== 'SUCCEEDED' && status !== 'FAILED' && attempts < maxAttempts) {
    await new Promise(r => setTimeout(r, 5000)); // Wait 5 seconds
    
    const statusResponse = await fetch(`${MESHY_API_URL}/openapi/v1/image-to-3d/${taskId}`, {
      headers: { 'Authorization': `Bearer ${MESHY_API_KEY}` }
    });
    
    result = await statusResponse.json();
    status = result.status;
    attempts++;
    
    console.log(`[FloorOverlay] Meshy status: ${status} (${result.progress || 0}%)`);
  }
  
  if (status === 'FAILED') {
    throw new Error(result.error_message || 'Meshy Image-to-3D failed');
  }
  
  if (status !== 'SUCCEEDED') {
    throw new Error('Meshy task timed out');
  }
  
  console.log('[FloorOverlay] ✅ 3D floor mesh created');
  return {
    modelUrl: result.model_urls?.glb || result.model_urls?.obj,
    thumbnailUrl: result.thumbnail_url,
    textureUrls: result.texture_urls,
    taskId
  };
}

/**
 * Download and save the floor model locally
 */
async function downloadFloorModel(modelUrl, taskId) {
  console.log('[FloorOverlay] Downloading floor model...');
  
  const response = await fetch(modelUrl);
  if (!response.ok) {
    throw new Error(`Failed to download model: ${response.status}`);
  }
  
  const buffer = await response.buffer();
  const ext = modelUrl.includes('.glb') ? 'glb' : 'obj';
  const filename = `floor_${taskId}.${ext}`;
  const filePath = path.join(FLOOR_MODELS_DIR, filename);
  
  fs.writeFileSync(filePath, buffer);
  console.log('[FloorOverlay] ✅ Model saved:', filename);
  
  return `/floor-models/${filename}`;
}

/**
 * POST /api/floor-overlay/generate
 * 
 * Main endpoint: Generate a 3D floor overlay for renovation visualization
 * 
 * Request body:
 * - viewportImages: string[] - Base64 images from different angles
 * - materialKey: string - Preset key like 'oak-hardwood'
 * - customPrompt?: string - Custom material description
 * - floorBounds: { minX, maxX, minZ, maxZ, y } - Floor placement info
 * 
 * Response:
 * - success: boolean
 * - floorModelUrl: string - URL to the generated 3D floor
 * - floorImageUrl: string - URL to the generated floor image
 * - placement: { x, y, z, scaleX, scaleZ } - How to position the floor
 */
router.post('/generate', async (req, res) => {
  try {
    const {
      viewportImages,
      materialKey,
      customPrompt,
      floorBounds,
      roomContext
    } = req.body;
    
    if (!viewportImages || viewportImages.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'At least one viewport image is required'
      });
    }
    
    console.log('[FloorOverlay] 🏠 Starting floor overlay generation');
    console.log('[FloorOverlay] Material:', materialKey);
    console.log('[FloorOverlay] Images:', viewportImages.length);
    console.log('[FloorOverlay] Floor bounds:', floorBounds);
    
    // Get material description
    const materialDescription = customPrompt || FLOOR_MATERIALS[materialKey] || 
      `${materialKey} flooring with realistic texture and natural appearance`;
    
    // Step 1: Generate floor image with Gemini
    const floorImage = await generateFloorImage(viewportImages, materialDescription, roomContext);
    
    if (!floorImage) {
      return res.status(500).json({
        success: false,
        error: 'Failed to generate floor image'
      });
    }
    
    // Save floor image
    const imageId = uuidv4();
    const imageFilename = `floor_${imageId}.png`;
    const imagePath = path.join(FLOOR_IMAGES_DIR, imageFilename);
    const imageBuffer = Buffer.from(floorImage.imageData, 'base64');
    fs.writeFileSync(imagePath, imageBuffer);
    
    const floorImageUrl = `/floor-overlays/${imageFilename}`;
    console.log('[FloorOverlay] Floor image saved:', floorImageUrl);
    
    // Get public URL for Meshy
    // Priority: TUNNEL_URL (Cloudflare), PUBLIC_URL, then localhost
    const baseUrl = process.env.TUNNEL_URL || process.env.CLOUDFLARE_TUNNEL_URL || process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3001}`;
    const publicImageUrl = `${baseUrl}${floorImageUrl}`;
    
    console.log('[FloorOverlay] Base URL for Meshy:', baseUrl);
    console.log('[FloorOverlay] Public image URL:', publicImageUrl);
    
    // Step 2: Create 3D floor with Meshy Image-to-3D
    const meshyResult = await createFloor3D(publicImageUrl, materialDescription);
    
    // Step 3: Download and save the model locally
    const localModelUrl = await downloadFloorModel(meshyResult.modelUrl, meshyResult.taskId);
    
    // Step 4: Calculate placement info
    const placement = {
      x: floorBounds ? (floorBounds.minX + floorBounds.maxX) / 2 : 0,
      y: floorBounds?.y || 0,
      z: floorBounds ? (floorBounds.minZ + floorBounds.maxZ) / 2 : 0,
      width: floorBounds ? (floorBounds.maxX - floorBounds.minX) : 1,
      depth: floorBounds ? (floorBounds.maxZ - floorBounds.minZ) : 1,
    };
    
    console.log('[FloorOverlay] ✅ Floor overlay complete!');
    
    res.json({
      success: true,
      floorImageUrl,
      floorModelUrl: localModelUrl,
      meshyModelUrl: meshyResult.modelUrl,
      thumbnailUrl: meshyResult.thumbnailUrl,
      placement,
      materialKey,
      taskId: meshyResult.taskId
    });
    
  } catch (error) {
    console.error('[FloorOverlay] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/floor-overlay/generate-image-only
 * 
 * Just generate the floor image (for preview before 3D generation)
 */
router.post('/generate-image-only', async (req, res) => {
  try {
    const { viewportImages, materialKey, customPrompt, roomContext } = req.body;
    
    if (!viewportImages || viewportImages.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'At least one viewport image is required'
      });
    }
    
    console.log('[FloorOverlay] 🎨 Generating floor image preview');
    
    const materialDescription = customPrompt || FLOOR_MATERIALS[materialKey] || 
      `${materialKey} flooring with realistic texture`;
    
    const floorImage = await generateFloorImage(viewportImages, materialDescription, roomContext);
    
    if (!floorImage) {
      return res.status(500).json({
        success: false,
        error: 'Failed to generate floor image'
      });
    }
    
    // Save and return
    const imageId = uuidv4();
    const imageFilename = `floor_preview_${imageId}.png`;
    const imagePath = path.join(FLOOR_IMAGES_DIR, imageFilename);
    fs.writeFileSync(imagePath, Buffer.from(floorImage.imageData, 'base64'));
    
    res.json({
      success: true,
      floorImageUrl: `/floor-overlays/${imageFilename}`,
      floorImageDataUrl: `data:${floorImage.mimeType};base64,${floorImage.imageData}`,
      materialKey
    });
    
  } catch (error) {
    console.error('[FloorOverlay] Preview error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/floor-overlay/materials
 * 
 * Get available floor material presets
 */
router.get('/materials', (req, res) => {
  const materials = Object.entries(FLOOR_MATERIALS).map(([key, description]) => ({
    key,
    name: key.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
    description
  }));
  
  res.json({ success: true, materials });
});

export default router;
