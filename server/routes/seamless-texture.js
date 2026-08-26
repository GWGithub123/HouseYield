/**
 * Seamless Texture Generation API Routes
 * 
 * Uses Gemini Nano Banana Pro (gemini-2.5-flash-image) to generate
 * high-quality, seamless tileable textures for 3D mesh retexturing.
 * 
 * Part of the Segmented Retexturing Pipeline:
 * 1. Segment mesh → 2. Generate texture (this) → 3. Apply texture (Meshy) → 4. Reassemble
 */

import express from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.Gemini_API_Key || process.env.GEMINI_API_KEY);

// Configuration
const TEXTURES_DIR = path.join(process.cwd(), 'public', 'generated-textures');

// Ensure textures directory exists
if (!fs.existsSync(TEXTURES_DIR)) {
  fs.mkdirSync(TEXTURES_DIR, { recursive: true });
}

// Material descriptions for realistic textures
const MATERIAL_DESCRIPTIONS = {
  flooring: {
    'oak-hardwood': 'polished warm oak hardwood floor planks, natural wood grain with subtle knots, matte finish, realistic wood texture',
    'walnut-hardwood': 'rich dark walnut hardwood floor planks, deep brown tones with natural grain variation, satin finish',
    'light-maple': 'light blonde maple hardwood floor planks, clean modern appearance, subtle grain pattern',
    'herringbone-parquet': 'classic herringbone pattern parquet flooring, medium oak wood, elegant interlocking planks',
    'white-oak-wide-plank': 'wide plank white oak flooring, light natural wood color, rustic farmhouse style with visible grain',
    'gray-vinyl-plank': 'modern gray luxury vinyl plank flooring, waterproof laminate look, contemporary style',
    'marble-tile': 'white Carrara marble tile flooring, polished surface with elegant gray veining',
    'slate-tile': 'natural slate tile flooring, gray stone texture with subtle color variation',
    'concrete-polished': 'polished concrete floor, industrial modern look, smooth gray surface with subtle aggregate',
    'terracotta-tile': 'terracotta clay tile flooring, warm Mediterranean earth tones, rustic texture',
  },
  walls: {
    'white-paint': 'clean white painted wall, smooth matte finish, bright and airy',
    'warm-gray': 'sophisticated warm gray painted wall, modern neutral color, eggshell finish',
    'navy-blue': 'deep navy blue painted wall, bold accent color, satin finish',
    'sage-green': 'soft sage green painted wall, natural calming color, matte finish',
    'exposed-brick': 'exposed red brick wall, industrial loft style, rustic mortar texture',
    'white-shiplap': 'white painted shiplap wall paneling, farmhouse style, horizontal boards with subtle shadows',
    'wood-paneling': 'natural wood wall paneling, warm brown tones, mid-century modern vertical boards',
    'beadboard': 'white beadboard wainscoting, classic cottage style, vertical lines with subtle depth',
  },
  countertops: {
    'white-quartz': 'white quartz countertop surface, clean modern look, subtle gray veining',
    'black-granite': 'black granite countertop with gold and silver flecks, polished luxury surface',
    'butcher-block': 'butcher block wood countertop, warm maple end-grain, kitchen island style',
    'marble': 'white marble countertop with dramatic gray veining, classic elegant surface',
    'concrete': 'polished concrete countertop, industrial modern style, smooth gray surface',
  }
};

/**
 * Generate a seamless tileable texture using Gemini Nano Banana Pro
 * NEW: If viewportImage is provided, Gemini sees the room and generates
 * flooring/walls/countertops that match the room's lighting and context
 */
async function generateSeamlessTexture(prompt, options = {}) {
  const {
    aspectRatio = '1:1',
    resolution = '1024x1024',
    tileSize = { width: 1, height: 1 }, // Real-world size in meters
    viewportImage = null, // Base64 screenshot from user's top-down view
  } = options;
  
  // Use Gemini 2.5 Flash Image (Nano Banana Pro)
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-image' });
  
  let fullPrompt, contentParts;
  
  if (viewportImage) {
    // CONTEXT-AWARE MODE: User provided a screenshot of their room
    // Gemini analyzes the room and generates a texture that matches the lighting/atmosphere
    fullPrompt = `You are viewing a top-down render of a 3D scanned room. Analyze this room's lighting, shadows, color temperature, and overall atmosphere.

Your task is to generate a SEAMLESS TILEABLE TEXTURE for ${prompt} that would look natural in this specific room.

CRITICAL INSTRUCTIONS:
1. Analyze the room's existing lighting conditions (warm/cool, bright/dim, shadow patterns)
2. Generate ONLY the ${prompt} texture itself - NOT the full room, just the material surface
3. Match the texture's lighting and color temperature to the room's atmosphere
4. If the room has warm lighting → generate warmer tones; cool lighting → cooler tones
5. The texture MUST be perfectly seamless (edges tile perfectly)
6. Top-down orthographic view with NO perspective distortion
7. Include subtle shadows/highlights that match the room's lighting direction
8. Photorealistic quality with natural material variation
9. This is a ${tileSize.width}m × ${tileSize.height}m tileable section

ROOM CONTEXT (for reference):
${viewportImage ? '[Room screenshot provided - analyze lighting and atmosphere]' : 'No room context'}

OUTPUT: A seamless, tileable texture of ${prompt} that would look natural when applied to this specific room's ${prompt === prompt ? 'surfaces' : prompt}.
Resolution: ${resolution}

DO NOT output the full room - only output the texture itself that will be applied to the 3D mesh.`;
    
    // Extract base64 image data
    let imageBase64 = viewportImage;
    if (viewportImage.startsWith('data:')) {
      const matches = viewportImage.match(/^data:([^;]+);base64,(.+)$/);
      if (matches) {
        imageBase64 = matches[2];
      }
    }
    
    contentParts = [
      { text: fullPrompt },
      {
        inlineData: {
          mimeType: 'image/png',
          data: imageBase64
        }
      }
    ];
    
    console.log('[SeamlessTexture] Using context-aware mode - generating texture that matches room lighting');
    
  } else {
    // ORIGINAL MODE: Generate generic seamless texture without room context
    fullPrompt = `Generate a perfectly seamless tileable texture:

${prompt}

CRITICAL REQUIREMENTS FOR SEAMLESS TILING:
- The texture MUST tile seamlessly - left edge matches right edge perfectly, top edge matches bottom edge perfectly
- Top-down orthographic view, absolutely NO perspective distortion
- Even, diffuse lighting with NO shadows, NO hotspots, NO directional lighting
- No visible edge artifacts or seams when the texture is repeated
- Photorealistic quality with natural material variation
- Do NOT include any room context, furniture, objects, or environment
- ONLY show the material surface itself, nothing else
- The texture should look natural when tiled 4x4 or more times
- Ensure the pattern doesn't have obvious repeating elements that would look artificial when tiled

This texture represents a ${tileSize.width}m × ${tileSize.height}m section of the material.
Resolution: ${resolution}`;
    
    contentParts = [{ text: fullPrompt }];
    
    console.log('[SeamlessTexture] Using generic seamless mode');
  }
  
  console.log('[SeamlessTexture] Generating with prompt:', prompt.substring(0, 100) + '...');
  
  const result = await model.generateContent({
    contents: [{
      role: 'user',
      parts: contentParts // Use either text-only or text + image
    }],
    generationConfig: {
      responseModalities: ['image', 'text'],
    }
  });
  
  const response = await result.response;
  const parts = response.candidates?.[0]?.content?.parts || [];
  
  let imageData = null;
  let mimeType = 'image/png';
  let textResponse = '';
  
  for (const part of parts) {
    if (part.inlineData) {
      imageData = part.inlineData.data;
      mimeType = part.inlineData.mimeType || 'image/png';
    }
    if (part.text) {
      textResponse = part.text;
    }
  }
  
  return {
    imageData,
    mimeType,
    description: textResponse
  };
}

// ============================================================================
// API Endpoints
// ============================================================================

/**
 * POST /api/seamless-textures/generate
 * Alias for /generate-seamless for simpler API usage
 * 
 * Request body:
 * - surfaceType: 'flooring' | 'walls' | 'countertops'
 * - materialOption: string - Preset key or 'custom'
 * - customPrompt?: string - Custom description if materialOption is 'custom'
 * - tileSize?: { width: number, height: number } - Real-world size in meters
 * 
 * Response:
 * - success: boolean
 * - textureUrl: string - URL to the generated texture
 * - textureDataUrl: string - Base64 data URL (for immediate use)
 */
router.post('/generate', async (req, res) => {
  try {
    const {
      surfaceType = 'flooring',
      materialOption,
      customPrompt,
      tileSize = { width: 1, height: 1 },
      viewportImage,
    } = req.body;
    
    console.log('[SeamlessTexture] 🎨 Generating texture');
    console.log('[SeamlessTexture] Surface:', surfaceType, '- Material:', materialOption);
    console.log('[SeamlessTexture] Viewport context:', !!viewportImage);
    
    // Get material description
    let materialDescription = customPrompt;
    
    if (!materialDescription && materialOption) {
      materialDescription = MATERIAL_DESCRIPTIONS[surfaceType]?.[materialOption];
    }
    
    if (!materialDescription) {
      materialDescription = `${materialOption || 'natural'} ${surfaceType} surface texture`;
    }
    
    // Generate the texture
    const result = await generateSeamlessTexture(materialDescription, { 
      tileSize,
      viewportImage
    });
    
    if (!result.imageData) {
      console.log('[SeamlessTexture] ⚠️ No image generated');
      return res.status(500).json({
        success: false,
        error: 'Failed to generate texture image',
        description: result.description
      });
    }
    
    // Save texture to file
    const textureId = uuidv4();
    const extension = result.mimeType.includes('png') ? 'png' : 'jpg';
    const filename = `texture_${textureId}.${extension}`;
    const filePath = path.join(TEXTURES_DIR, filename);
    
    const imageBuffer = Buffer.from(result.imageData, 'base64');
    fs.writeFileSync(filePath, imageBuffer);
    
    console.log('[SeamlessTexture] ✅ Texture saved:', filename);
    
    const textureUrl = `/generated-textures/${filename}`;
    const textureDataUrl = `data:${result.mimeType};base64,${result.imageData}`;
    
    res.json({
      success: true,
      textureId,
      textureUrl,
      textureDataUrl,
      surfaceType,
      materialOption,
      tileSize,
      description: result.description,
      filename,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('[SeamlessTexture] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/seamless-textures/generate-seamless
 * 
 * Generate a seamless tileable texture using Gemini Nano Banana Pro
 * 
 * Request body:
 * - surfaceType: 'flooring' | 'walls' | 'countertops'
 * - materialOption: string - Preset key or 'custom'
 * - customPrompt?: string - Custom description if materialOption is 'custom'
 * - tileSize?: { width: number, height: number } - Real-world size in meters
 * 
 * Response:
 * - success: boolean
 * - textureUrl: string - URL to the generated texture
 * - textureDataUrl: string - Base64 data URL (for immediate use)
 */
router.post('/generate-seamless', async (req, res) => {
  try {
    const {
      surfaceType = 'flooring',
      materialOption,
      customPrompt,
      tileSize = { width: 1, height: 1 },
      viewportImage, // NEW: Base64 screenshot from user's viewport
    } = req.body;
    
    console.log('[SeamlessTexture] 🎨 Generating texture');
    console.log('[SeamlessTexture] Surface:', surfaceType, '- Material:', materialOption);
    console.log('[SeamlessTexture] Viewport context:', !!viewportImage);
    
    // Get material description
    let materialDescription = customPrompt;
    
    if (!materialDescription && materialOption) {
      materialDescription = MATERIAL_DESCRIPTIONS[surfaceType]?.[materialOption];
    }
    
    if (!materialDescription) {
      materialDescription = `${materialOption || 'natural'} ${surfaceType} surface texture`;
    }
    
    // Generate the texture (with or without viewport context)
    const result = await generateSeamlessTexture(materialDescription, { 
      tileSize,
      viewportImage // Pass viewport screenshot for context-aware generation
    });
    
    if (!result.imageData) {
      console.log('[SeamlessTexture] ⚠️ No image generated');
      return res.status(500).json({
        success: false,
        error: 'Failed to generate texture image',
        description: result.description
      });
    }
    
    // Save texture to file
    const textureId = uuidv4();
    const extension = result.mimeType.includes('png') ? 'png' : 'jpg';
    const filename = `texture_${textureId}.${extension}`;
    const filePath = path.join(TEXTURES_DIR, filename);
    
    const imageBuffer = Buffer.from(result.imageData, 'base64');
    fs.writeFileSync(filePath, imageBuffer);
    
    console.log('[SeamlessTexture] ✅ Texture saved:', filename);
    
    const textureUrl = `/generated-textures/${filename}`;
    const textureDataUrl = `data:${result.mimeType};base64,${result.imageData}`;
    
    res.json({
      success: true,
      textureId,
      textureUrl,
      textureDataUrl,
      surfaceType,
      materialOption,
      tileSize,
      description: result.description,
      filename,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('[SeamlessTexture] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/textures/generate-from-reference
 * 
 * Generate a texture based on a reference image (e.g., match existing flooring)
 */
router.post('/generate-from-reference', async (req, res) => {
  try {
    const {
      referenceImage, // Base64 image data
      surfaceType = 'flooring',
      prompt,
      tileSize = { width: 1, height: 1 },
    } = req.body;
    
    if (!referenceImage) {
      return res.status(400).json({
        success: false,
        error: 'referenceImage is required'
      });
    }
    
    console.log('[SeamlessTexture] 🖼️ Generating texture from reference');
    
    // Extract base64 data
    let imageBase64 = referenceImage;
    let imageMimeType = 'image/jpeg';
    
    if (referenceImage.startsWith('data:')) {
      const matches = referenceImage.match(/^data:([^;]+);base64,(.+)$/);
      if (matches) {
        imageMimeType = matches[1];
        imageBase64 = matches[2];
      }
    }
    
    const fullPrompt = `Analyze this reference image and generate a seamless tileable texture that matches its style and material.

${prompt || `Create a seamless ${surfaceType} texture based on this reference.`}

REQUIREMENTS:
- Match the color, pattern, and material characteristics of the reference
- Make it perfectly seamless and tileable
- Top-down orthographic view with no perspective
- Even lighting, no shadows
- Photorealistic quality`;

    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-image' });
    
    const result = await model.generateContent({
      contents: [{
        role: 'user',
        parts: [
          {
            inlineData: {
              mimeType: imageMimeType,
              data: imageBase64
            }
          },
          { text: fullPrompt }
        ]
      }],
      generationConfig: {
        responseModalities: ['image', 'text'],
      }
    });
    
    const response = await result.response;
    const parts = response.candidates?.[0]?.content?.parts || [];
    
    let generatedImageData = null;
    let generatedMimeType = 'image/png';
    let textResponse = '';
    
    for (const part of parts) {
      if (part.inlineData) {
        generatedImageData = part.inlineData.data;
        generatedMimeType = part.inlineData.mimeType || 'image/png';
      }
      if (part.text) {
        textResponse = part.text;
      }
    }
    
    if (!generatedImageData) {
      return res.status(500).json({
        success: false,
        error: 'Failed to generate texture from reference',
        description: textResponse
      });
    }
    
    // Save texture
    const textureId = uuidv4();
    const extension = generatedMimeType.includes('png') ? 'png' : 'jpg';
    const filename = `texture_ref_${textureId}.${extension}`;
    const filePath = path.join(TEXTURES_DIR, filename);
    
    fs.writeFileSync(filePath, Buffer.from(generatedImageData, 'base64'));
    
    console.log('[SeamlessTexture] ✅ Reference-based texture saved:', filename);
    
    res.json({
      success: true,
      textureId,
      textureUrl: `/generated-textures/${filename}`,
      textureDataUrl: `data:${generatedMimeType};base64,${generatedImageData}`,
      surfaceType,
      description: textResponse,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('[SeamlessTexture] Reference generation error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/textures/presets
 * 
 * Get available texture presets
 */
router.get('/presets', (req, res) => {
  const presets = {};
  
  for (const [surfaceType, materials] of Object.entries(MATERIAL_DESCRIPTIONS)) {
    presets[surfaceType] = Object.keys(materials).map(key => ({
      key,
      name: key.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
      description: materials[key]
    }));
  }
  
  res.json({
    success: true,
    presets
  });
});

/**
 * DELETE /api/textures/:textureId
 * 
 * Delete a generated texture
 */
router.delete('/:textureId', (req, res) => {
  try {
    const { textureId } = req.params;
    
    // Find and delete the texture file
    const files = fs.readdirSync(TEXTURES_DIR);
    const matchingFile = files.find(f => f.includes(textureId));
    
    if (matchingFile) {
      fs.unlinkSync(path.join(TEXTURES_DIR, matchingFile));
      return res.json({ success: true, message: 'Texture deleted' });
    }
    
    res.status(404).json({
      success: false,
      error: 'Texture not found'
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/seamless-textures/edit-room
 * 
 * Takes a captured viewport image of the 3D room and edits it to apply
 * the desired flooring/wall/countertop material to the actual surfaces.
 * This creates a realistic "before/after" style reference for Meshy.
 * 
 * Request body:
 * - viewportImage: string (required) - Base64 image captured from user's viewport
 * - surfaceType: 'flooring' | 'walls' | 'countertops'
 * - materialDescription: string - Description of the desired material
 * - preserveRoom: boolean - If true, only change the specified surface
 * 
 * Response:
 * - success: boolean
 * - editedImageUrl: string - URL to the edited room image
 * - editedImageDataUrl: string - Base64 data URL for immediate use
 */
router.post('/edit-room', async (req, res) => {
  try {
    const {
      viewportImage,
      surfaceType = 'flooring',
      materialDescription,
      materialOption,
      preserveRoom = true,
    } = req.body;
    
    if (!viewportImage) {
      return res.status(400).json({
        success: false,
        error: 'viewportImage is required - capture the 3D viewport first'
      });
    }
    
    console.log('[SeamlessTexture] 🏠 Editing room image to apply', surfaceType);
    console.log('[SeamlessTexture] Material:', materialDescription || materialOption);
    
    // Get material description
    let material = materialDescription;
    if (!material && materialOption) {
      material = MATERIAL_DESCRIPTIONS[surfaceType]?.[materialOption] || materialOption;
    }
    if (!material) {
      material = `beautiful ${surfaceType} surface`;
    }
    
    // Use Gemini image-generation model (Nano Banana) for image editing
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-image' });
    
    // Build the edit prompt based on surface type
    const surfacePrompts = {
      flooring: `You are editing a photograph of a real room. Your task is to replace ONLY the floor with ${material}.

CRITICAL RULES - FOLLOW EXACTLY:
1. DO NOT change ANYTHING except the floor surface - walls, furniture, ceiling, objects, lighting, shadows, colors of everything else must remain PIXEL-PERFECT identical
2. The floor must use REAL-WORLD ACCURATE dimensions - if this appears to be a standard room (10-15 feet across), show the correct number of wood planks that would actually fit
3. Standard hardwood planks are approximately 3-5 inches wide - calculate how many would realistically fit across this room's floor
4. Match the perspective and angle of the existing floor exactly
5. The new ${material} must have realistic shadows, reflections, and lighting that match the room's existing light sources
6. Preserve all furniture shadows on the floor - just change the floor material under them
7. Keep the floor boundaries and shape exactly as they appear in the original

This is a renovation visualization - I want to see exactly how this room would look with ${material} installed, with nothing else changed.

Output a single edited image showing the renovation.`,
      
      walls: `You are editing a photograph of a real room. Your task is to replace ONLY the walls with ${material}.

CRITICAL RULES - FOLLOW EXACTLY:
1. DO NOT change ANYTHING except the wall surfaces - floor, furniture, ceiling, objects, lighting must remain PIXEL-PERFECT identical
2. Match the perspective and angle of the existing walls exactly
3. The new ${material} must have realistic shadows and lighting that match the room's existing light sources
4. Preserve all objects against the walls - just change the wall material behind them

This is a renovation visualization - I want to see exactly how this room would look with ${material} on the walls, with nothing else changed.`,
      
      countertops: `You are editing a photograph of a real kitchen/bathroom. Your task is to replace ONLY the countertop surfaces with ${material}.

CRITICAL RULES - FOLLOW EXACTLY:
1. DO NOT change ANYTHING except the countertop surfaces - cabinets, floor, appliances, walls must remain PIXEL-PERFECT identical
2. Match the perspective and shape of the existing countertops exactly
3. The new ${material} must have realistic reflections and lighting that match the room's existing light sources
4. Preserve all items on the countertops - just change the surface material under them

This is a renovation visualization - I want to see exactly how this space would look with ${material} countertops, with nothing else changed.`,
    };
    
    const editPrompt = preserveRoom 
      ? surfacePrompts[surfaceType] || surfacePrompts.flooring
      : `Transform this room to have ${material} ${surfaceType}. Create a beautiful, realistic renovation visualization.`;
    
    // Extract base64 image data
    let imageBase64 = viewportImage;
    let imageMimeType = 'image/png';
    
    if (viewportImage.startsWith('data:')) {
      const matches = viewportImage.match(/^data:([^;]+);base64,(.+)$/);
      if (matches) {
        imageMimeType = matches[1];
        imageBase64 = matches[2];
      }
    }
    
    console.log('[SeamlessTexture] Sending image to Gemini for editing...');
    
    const result = await model.generateContent({
      contents: [{
        role: 'user',
        parts: [
          { text: editPrompt },
          {
            inlineData: {
              mimeType: imageMimeType,
              data: imageBase64
            }
          }
        ]
      }],
      generationConfig: {
        responseModalities: ['image', 'text'],
      }
    });
    
    const response = await result.response;
    const parts = response.candidates?.[0]?.content?.parts || [];
    
    let editedImageData = null;
    let editedMimeType = 'image/png';
    let textResponse = '';
    
    for (const part of parts) {
      if (part.inlineData) {
        editedImageData = part.inlineData.data;
        editedMimeType = part.inlineData.mimeType || 'image/png';
      }
      if (part.text) {
        textResponse = part.text;
      }
    }
    
    if (!editedImageData) {
      console.log('[SeamlessTexture] ⚠️ Gemini did not return an edited image');
      console.log('[SeamlessTexture] Text response:', textResponse);
      return res.status(500).json({
        success: false,
        error: 'Failed to generate edited room image',
        description: textResponse
      });
    }
    
    // Save edited image
    const imageId = uuidv4();
    const extension = editedMimeType.includes('png') ? 'png' : 'jpg';
    const filename = `room_edit_${surfaceType}_${imageId}.${extension}`;
    const filePath = path.join(TEXTURES_DIR, filename);
    
    fs.writeFileSync(filePath, Buffer.from(editedImageData, 'base64'));
    
    console.log('[SeamlessTexture] ✅ Edited room image saved:', filename);
    
    res.json({
      success: true,
      imageId,
      editedImageUrl: `/generated-textures/${filename}`,
      editedImageDataUrl: `data:${editedMimeType};base64,${editedImageData}`,
      surfaceType,
      material,
      description: textResponse,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('[SeamlessTexture] Room edit error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;
