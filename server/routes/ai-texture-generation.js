/**
 * AI Texture Generation Routes
 * 
 * Backend endpoint for generating seamless tileable textures using Gemini Nano Banana.
 * These textures are applied to 3D mesh segments for realistic renovation previews.
 * 
 * Models:
 * - gemini-2.5-flash-image (Nano Banana) - Fast, efficient
 * - gemini-3-pro-image-preview (Nano Banana Pro) - High quality, complex instructions
 */

import express from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

const router = express.Router();

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.Gemini_API_Key || process.env.GEMINI_API_KEY);

// Setup for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create temp directory for generated textures
const TEXTURE_DIR = path.join(__dirname, '../temp/textures');
if (!fs.existsSync(TEXTURE_DIR)) {
  fs.mkdirSync(TEXTURE_DIR, { recursive: true });
}

// ============================================================================
// Generate Texture for 3D Mesh Segment
// ============================================================================

router.post('/generate-texture', async (req, res) => {
  try {
    const {
      segmentImage,      // Base64 image of current segment (optional reference)
      segmentType,       // 'floor', 'wall', 'ceiling', 'counter'
      renovationType,    // 'flooring', 'paint', 'countertop'
      renovationOption,  // 'hardwood', 'tile', 'white', etc.
      dimensions,        // { width, height, area } in meters
      prompt,            // Pre-generated prompt from frontend (may contain exact dimensions)
      useProModel,       // Use Nano Banana Pro for higher quality
    } = req.body;
    
    console.log('[AI Texture] Generating texture with Nano Banana for:', {
      segmentType,
      renovationType,
      renovationOption,
      dimensions,
      useProModel: useProModel || false,
      hasCustomPrompt: !!prompt && prompt.length > 100, // Check if it's a detailed prompt
    });
    
    // Choose model - Pro for high quality, Flash for speed
    const modelName = useProModel 
      ? 'gemini-3-pro-image-preview'  // Nano Banana Pro
      : 'gemini-2.5-flash-image';      // Nano Banana
    
    console.log('[AI Texture] Using model:', modelName);
    
    // Use frontend prompt if it contains dimension data, otherwise use built-in prompts
    let texturePrompt = '';
    
    // Check if frontend sent a custom prompt (longer prompts are custom)
    if (prompt && prompt.length > 100) {
      // Frontend sent a detailed custom prompt - use it
      texturePrompt = prompt;
      console.log('[AI Texture] Using custom prompt from frontend');
    } else {
      // Fall back to built-in material prompts
      const materialPrompts = {
        flooring: {
          hardwood: 'Generate a photograph of classic hardwood floor planks from directly above. The planks are horizontal and parallel. Rich medium-brown to dark honey oak color with prominent natural wood grain patterns running lengthwise. Each plank is about 5 inches wide. Show natural knots, grain variations, and thin dark gaps between boards. The wood should look warm, polished, and traditional like a classic American hardwood floor. Top-down view only. No perspective, no shadows, no reflections, no furniture. Just the beautiful hardwood floor surface filling the entire image.',
          walnut: 'Generate a photograph of dark walnut hardwood floor planks from directly above. Horizontal parallel planks, each about 5 inches wide. Rich dark brown color with visible wood grain. Small gaps between planks. Realistic texture. No objects or shadows. Just floor surface.',
          tile: 'Generate a photograph of large gray ceramic floor tiles from directly above. Square 24-inch tiles arranged in a grid. Light gray color with subtle texture. Thin grout lines between tiles. No objects. Just tile floor.',
          marble: 'Generate a photograph of white marble floor from directly above. Polished white surface with gray veining pattern. Elegant natural stone look. No objects. Just marble surface.',
          vinyl: 'Generate a photograph of vinyl plank flooring from directly above. Wood-look planks, light oak color, horizontal arrangement. Realistic faux wood grain. No objects.',
          carpet: 'Generate a photograph of beige carpet from directly above. Soft plush texture, neutral warm beige color. Subtle fiber pattern. No objects.',
        },
        paint: {
          white: 'Generate a photograph of a plain white painted wall surface. Flat front view. Clean matte white with slight texture. No objects, no shadows. Just wall surface.',
          gray: 'Generate a photograph of a plain light gray painted wall surface. Flat front view. Clean matte gray. No objects. Just wall.',
          beige: 'Generate a photograph of a plain beige painted wall surface. Flat front view. Warm neutral beige. No objects.',
          navy: 'Generate a photograph of a plain navy blue painted wall surface. Flat front view. Deep blue matte finish. No objects.',
          sage: 'Generate a photograph of a plain sage green painted wall surface. Flat front view. Soft green color. No objects.',
        },
        countertop: {
          granite: 'Generate a photograph of black granite countertop from directly above. Polished surface with natural stone speckles. No objects.',
          quartz: 'Generate a photograph of white quartz countertop from directly above. White with subtle gray veining. Polished. No objects.',
          marble: 'Generate a photograph of Carrara marble countertop from directly above. White with elegant gray veins. Polished. No objects.',
          butcher_block: 'Generate a photograph of butcher block wood countertop from directly above. Light wood with visible grain pattern. No objects.',
        },
      };
      
      // Get specific prompt or build from request
      texturePrompt = materialPrompts[renovationType]?.[renovationOption];
      
      if (!texturePrompt) {
        // Fallback to generic prompt
        texturePrompt = `Create an image of a ${renovationOption} ${renovationType} texture. Photorealistic, seamless tileable, suitable for 3D rendering. ${segmentType === 'floor' ? 'Top-down view.' : 'Front-facing view.'}`;
      }
      
      // Add dimensions if available
      if (dimensions?.width && dimensions?.height) {
        texturePrompt += ` The surface covers approximately ${dimensions.width.toFixed(1)}m × ${dimensions.height.toFixed(1)}m.`;
      }
    }
    
    console.log('[AI Texture] Prompt:', texturePrompt.substring(0, 200) + '...');

    // Helper function to try generating with a model
    const tryGenerateWithModel = async (modelToUse) => {
      const model = genAI.getGenerativeModel({ model: modelToUse });
      const result = await model.generateContent(texturePrompt);
      const response = await result.response;
      
      if (response.candidates?.[0]?.content?.parts) {
        const parts = response.candidates[0].content.parts;
        
        for (const part of parts) {
          if (part.inlineData?.mimeType?.startsWith('image/')) {
            return {
              imageData: part.inlineData.data,
              mimeType: part.inlineData.mimeType,
            };
          }
        }
      }
      
      return null;
    };

    // Retry logic - try primary model up to 3 times, then fallback
    const maxRetries = 3;
    let generatedImage = null;
    let usedModel = modelName;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      console.log(`[AI Texture] Attempt ${attempt}/${maxRetries} with ${modelName}...`);
      try {
        generatedImage = await tryGenerateWithModel(modelName);
        if (generatedImage) break;
        console.log(`[AI Texture] Attempt ${attempt} returned no image, retrying...`);
      } catch (err) {
        console.log(`[AI Texture] Attempt ${attempt} error: ${err.message}`);
      }
      
      // Small delay between retries
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    // Try fallback model if primary failed
    if (!generatedImage) {
      const fallbackModel = useProModel 
        ? 'gemini-2.5-flash-image' 
        : 'gemini-3-pro-image-preview';
      
      console.log(`[AI Texture] Primary model failed, trying fallback: ${fallbackModel}`);
      
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          generatedImage = await tryGenerateWithModel(fallbackModel);
          if (generatedImage) {
            usedModel = fallbackModel;
            break;
          }
        } catch (err) {
          console.log(`[AI Texture] Fallback attempt ${attempt} error: ${err.message}`);
        }
      }
    }
    
    // Check if we got an image
    if (!generatedImage) {
      throw new Error('Failed to generate texture after multiple attempts with both models');
    }
    
    // Save the generated image
    const { imageData, mimeType } = generatedImage;
    const extension = mimeType.split('/')[1] || 'png';
    const filename = `texture_${segmentType}_${renovationOption}_${Date.now()}.${extension}`;
    const filepath = path.join(TEXTURE_DIR, filename);
    const buffer = Buffer.from(imageData, 'base64');
    fs.writeFileSync(filepath, buffer);
    
    const textureUrl = `/api/textures/${filename}`;
    const textureDataUrl = `data:${mimeType};base64,${imageData}`;
    
    console.log('[AI Texture] ✅ Generated texture:', textureUrl, 'using', usedModel);
    
    return res.json({
      success: true,
      textureUrl,
      textureDataUrl,
      dimensions,
      segmentType,
      renovationType,
      renovationOption,
      model: usedModel,
      generatedAt: new Date().toISOString(),
    });
    
  } catch (error) {
    console.error('[AI Texture] Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate texture',
      details: error.message,
    });
  }
});

// ============================================================================
// Serve Generated Textures
// ============================================================================

router.get('/:filename', (req, res) => {
  const filename = req.params.filename;
  const filepath = path.join(TEXTURE_DIR, filename);
  
  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'Texture not found' });
  }
  
  res.sendFile(filepath);
});

// ============================================================================
// List Generated Textures
// ============================================================================

router.get('/', (req, res) => {
  try {
    const files = fs.readdirSync(TEXTURE_DIR);
    const textures = files.map(file => ({
      filename: file,
      url: `/api/textures/${file}`,
      created: fs.statSync(path.join(TEXTURE_DIR, file)).mtime,
    }));
    
    res.json({
      success: true,
      textures,
      count: textures.length,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ============================================================================
// Clean Up Old Textures
// ============================================================================

router.delete('/cleanup', (req, res) => {
  try {
    const files = fs.readdirSync(TEXTURE_DIR);
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    const now = Date.now();
    let deleted = 0;
    
    files.forEach(file => {
      const filepath = path.join(TEXTURE_DIR, file);
      const stats = fs.statSync(filepath);
      
      if (now - stats.mtime.getTime() > maxAge) {
        fs.unlinkSync(filepath);
        deleted++;
      }
    });
    
    res.json({
      success: true,
      message: `Deleted ${deleted} old texture files`,
      deleted,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ============================================================================
// AI Renovation Preview - Image-to-Image transformation
// Takes a screenshot of the room and applies renovations using Gemini
// ============================================================================

router.post('/renovate-image', async (req, res) => {
  try {
    const {
      roomImage,           // Base64 image of the room (screenshot from 3D view)
      renovationType,      // 'flooring', 'paint', 'countertop'
      renovationOption,    // 'hardwood', 'tile', 'white', etc.
      roomDimensions,      // { width, height } in meters (optional)
      customPrompt,        // Custom renovation prompt (optional)
    } = req.body;
    
    if (!roomImage) {
      return res.status(400).json({ 
        success: false,
        error: 'Missing required field: roomImage (base64)' 
      });
    }
    
    console.log('[AI Renovation] Starting image-to-image renovation:', {
      renovationType,
      renovationOption,
      hasRoomImage: !!roomImage,
      imageLength: roomImage?.length,
      hasDimensions: !!roomDimensions,
    });
    
    // Use Nano Banana for image editing (supports image generation)
    const modelName = 'gemini-2.5-flash-image';
    console.log('[AI Renovation] Using model:', modelName);
    
    // Build renovation prompt
    let renovationPrompt = '';
    
    if (customPrompt) {
      renovationPrompt = customPrompt;
    } else {
      // Build prompt based on renovation type
      const dimensionText = roomDimensions 
        ? `The room is ${roomDimensions.width.toFixed(1)}m × ${roomDimensions.height.toFixed(1)}m.` 
        : '';
      
      // Use the actual material name from the picker
      const materialName = renovationOption || 'hardwood flooring';
      
      if (renovationType === 'flooring') {
        // Detect flooring type from material name
        const isWalnut = materialName.toLowerCase().includes('walnut');
        const isOak = materialName.toLowerCase().includes('oak');
        const isMaple = materialName.toLowerCase().includes('maple');
        const isVinyl = materialName.toLowerCase().includes('vinyl');
        const isTile = materialName.toLowerCase().includes('tile');
        const isGray = materialName.toLowerCase().includes('gray') || materialName.toLowerCase().includes('grey');
        
        let colorDescription = 'warm medium-brown';
        if (isWalnut) colorDescription = 'rich dark walnut brown';
        if (isOak) colorDescription = 'honey golden oak';
        if (isMaple) colorDescription = 'light natural maple';
        if (isGray) colorDescription = 'cool modern gray';
        
        renovationPrompt = `Replace the floor in this room with beautiful ${materialName}.
${dimensionText}

The new flooring should have:
- ${colorDescription} color tones
${!isTile ? '- Visible wood grain pattern with realistic plank texture' : '- Clean tile pattern with thin grout lines'}
- Properly sized planks/tiles for a realistic look
- Natural lighting and shadows matching the room

IMPORTANT: Keep everything else in the room EXACTLY the same:
- Same furniture, bed, objects
- Same walls and wall color
- Same lighting conditions
- Same camera angle and perspective

Only replace the floor surface. Make it look like a professional renovation photo.`;
      } else if (renovationType === 'paint') {
        renovationPrompt = `Repaint the walls in this room with ${materialName}.
Keep the floor, furniture, and all objects EXACTLY the same.
Only change the wall paint color. Maintain realistic lighting.`;
      } else {
        renovationPrompt = `Apply ${materialName} to the ${renovationType} in this room.
Keep everything else in the room the same. Only change the ${renovationType}.`;
      }
    }
    
    console.log('[AI Renovation] Prompt:', renovationPrompt.substring(0, 200) + '...');
    
    // Prepare image for Gemini
    const imageData = roomImage.replace(/^data:image\/\w+;base64,/, '');
    
    const model = genAI.getGenerativeModel({ model: modelName });
    
    // Send image with editing prompt
    const result = await model.generateContent([
      {
        inlineData: {
          mimeType: 'image/jpeg',
          data: imageData,
        },
      },
      renovationPrompt,
    ]);
    
    const response = await result.response;
    
    // Check for generated image in response
    let generatedImage = null;
    
    if (response.candidates?.[0]?.content?.parts) {
      const parts = response.candidates[0].content.parts;
      
      for (const part of parts) {
        if (part.inlineData?.mimeType?.startsWith('image/')) {
          generatedImage = {
            imageData: part.inlineData.data,
            mimeType: part.inlineData.mimeType,
          };
          break;
        }
      }
    }
    
    if (!generatedImage) {
      // Model might have returned text instead of image
      const textResponse = response.text?.() || 'No image generated';
      console.log('[AI Renovation] No image returned, got text:', textResponse.substring(0, 200));
      
      return res.status(422).json({
        success: false,
        error: 'AI did not return an image. It may not support image editing with this prompt.',
        textResponse: textResponse.substring(0, 500),
      });
    }
    
    // Save the renovated image
    const filename = `renovation_${renovationType}_${renovationOption}_${Date.now()}.jpeg`;
    const filepath = path.join(TEXTURE_DIR, filename);
    
    const imageBuffer = Buffer.from(generatedImage.imageData, 'base64');
    fs.writeFileSync(filepath, imageBuffer);
    
    console.log('[AI Renovation] ✅ Generated renovation preview:', filename);
    
    res.json({
      success: true,
      renovatedImageUrl: `/api/textures/${filename}`,
      renovatedImageDataUrl: `data:${generatedImage.mimeType};base64,${generatedImage.imageData}`,
      renovationType,
      renovationOption,
      prompt: renovationPrompt,
    });
    
  } catch (error) {
    console.error('[AI Renovation] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      details: error.toString(),
    });
  }
});

export default router;

// ============================================================================
// Modify Mesh Texture - Takes the original texture and applies renovation
// This preserves UV mapping by editing the texture image directly
// ============================================================================

router.post('/modify-mesh-texture', async (req, res) => {
  try {
    const {
      textureImage,        // Base64 image of the original mesh texture
      textureUrl,          // URL to fetch texture from (alternative)
      renovationType,      // 'flooring', 'wall', 'ceiling'
      renovationOption,    // Material name like 'Luxury Vinyl Plank - Natural Oak'
      materialDescription, // Material description from the picker
      roomDimensions,      // { width, height } in meters (optional)
    } = req.body;
    
    let imageData = '';
    let mimeType = 'image/jpeg';
    
    // Get texture data either from base64 or URL
    if (textureImage) {
      imageData = textureImage.replace(/^data:image\/\w+;base64,/, '');
    } else if (textureUrl) {
      // Fetch texture from URL
      console.log('[Modify Texture] Fetching texture from:', textureUrl);
      const response = await fetch(textureUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch texture: ${response.status}`);
      }
      const buffer = await response.arrayBuffer();
      imageData = Buffer.from(buffer).toString('base64');
      mimeType = response.headers.get('content-type') || 'image/jpeg';
    } else {
      return res.status(400).json({ 
        success: false,
        error: 'Missing required field: textureImage or textureUrl' 
      });
    }
    
    // Resize large images to max 2048px for better AI processing
    const MAX_TEXTURE_SIZE = 2048;
    let processedImageData = imageData;
    let originalSize = { width: 0, height: 0 };
    
    try {
      const inputBuffer = Buffer.from(imageData, 'base64');
      const metadata = await sharp(inputBuffer).metadata();
      originalSize = { width: metadata.width || 0, height: metadata.height || 0 };
      
      console.log('[Modify Texture] Original texture size:', originalSize.width, 'x', originalSize.height);
      
      if ((metadata.width && metadata.width > MAX_TEXTURE_SIZE) || 
          (metadata.height && metadata.height > MAX_TEXTURE_SIZE)) {
        console.log('[Modify Texture] Resizing to max', MAX_TEXTURE_SIZE, 'px for AI processing...');
        
        const resizedBuffer = await sharp(inputBuffer)
          .resize(MAX_TEXTURE_SIZE, MAX_TEXTURE_SIZE, {
            fit: 'inside',
            withoutEnlargement: true,
          })
          .jpeg({ quality: 90 })
          .toBuffer();
        
        processedImageData = resizedBuffer.toString('base64');
        mimeType = 'image/jpeg';
        
        const resizedMeta = await sharp(resizedBuffer).metadata();
        console.log('[Modify Texture] Resized to:', resizedMeta.width, 'x', resizedMeta.height);
      }
    } catch (resizeError) {
      console.warn('[Modify Texture] Could not resize image:', resizeError.message);
      // Continue with original image
    }
    
    console.log('[Modify Texture] Starting texture modification:', {
      renovationType,
      renovationOption,
      imageDataLength: processedImageData.length,
      hasDimensions: !!roomDimensions,
    });
    
    // Use Gemini 2.5 Flash Image (Nano Banana) for image editing
    const modelName = 'gemini-2.5-flash-image';
    console.log('[Modify Texture] Using model:', modelName);
    
    // Build prompt for texture modification
    const dimensionText = roomDimensions 
      ? `The room is approximately ${roomDimensions.width.toFixed(1)}m × ${roomDimensions.height.toFixed(1)}m.` 
      : '';
    
    // Use the actual material name from the picker
    const materialName = renovationOption || 'hardwood flooring';
    const materialDesc = materialDescription || '';
    
    let modificationPrompt = '';
    
    if (renovationType === 'flooring') {
      // Determine flooring style from material name
      const isVinyl = materialName.toLowerCase().includes('vinyl');
      const isTile = materialName.toLowerCase().includes('tile') || materialName.toLowerCase().includes('porcelain');
      const isLaminate = materialName.toLowerCase().includes('laminate');
      const isEngineered = materialName.toLowerCase().includes('engineered');
      const isHardwood = materialName.toLowerCase().includes('hardwood') || materialName.toLowerCase().includes('oak') || materialName.toLowerCase().includes('walnut') || materialName.toLowerCase().includes('maple');
      
      // Extract color/style hints from name
      const colorHints = [];
      if (materialName.toLowerCase().includes('natural')) colorHints.push('natural warm tones');
      if (materialName.toLowerCase().includes('gray') || materialName.toLowerCase().includes('grey')) colorHints.push('gray/grey tones');
      if (materialName.toLowerCase().includes('walnut')) colorHints.push('rich dark walnut brown');
      if (materialName.toLowerCase().includes('oak')) colorHints.push('honey oak tones');
      if (materialName.toLowerCase().includes('maple')) colorHints.push('light maple');
      if (materialName.toLowerCase().includes('espresso') || materialName.toLowerCase().includes('dark')) colorHints.push('dark espresso brown');
      if (materialName.toLowerCase().includes('white')) colorHints.push('whitewashed/light');
      
      const colorDescription = colorHints.length > 0 ? colorHints.join(', ') : 'warm natural wood tones';
      
      modificationPrompt = `This image is a UV TEXTURE MAP from a 3D photogrammetry scan of a room.
A UV texture map is an UNWRAPPED image where the 3D surfaces are flattened. The floor appears as irregular shapes scattered throughout the image (not in the normal "bottom" position like a photo).

CRITICAL: Look for floor surface patches - they typically appear as:
- Larger continuous patches with uniform color/texture (often carpeted or wood-looking)
- May appear in multiple disconnected areas of the image
- Often have a different appearance than wall patches (which are usually more vertical/detailed)

YOUR TASK:
1. Identify ALL floor surface patches in this UV texture map
2. Replace ONLY those floor patches with ${materialName} flooring texture
3. The flooring should have: ${colorDescription}
${isHardwood || isEngineered ? '4. Show realistic wood grain running in a consistent direction across all floor patches' : ''}
${isVinyl || isLaminate ? '4. Clean, modern plank appearance with subtle texture' : ''}
${isTile ? '4. Rectangular tiles with thin grout lines' : ''}
5. Keep ALL other patches (walls, furniture, objects, ceiling) EXACTLY the same
6. The floor texture should tile seamlessly across patches

Output the modified UV texture map with only floor patches changed.`;
    } else if (renovationType === 'wall') {
      modificationPrompt = `This is a UV texture map from a 3D photogrammetry scan.
Repaint ONLY the wall regions with ${materialName}.
${materialDesc ? `Material description: ${materialDesc}` : ''}
Keep floors, furniture, and objects exactly the same.
Output the modified texture image.`;
    } else if (renovationType === 'ceiling') {
      modificationPrompt = `This is a UV texture map from a 3D photogrammetry scan.
Repaint ONLY the ceiling regions with ${materialName}.
${materialDesc ? `Material description: ${materialDesc}` : ''}
Keep floors, walls, furniture, and objects exactly the same.
Output the modified texture image.`;
    } else {
      modificationPrompt = `This is a UV texture map from a 3D photogrammetry scan.
Apply ${materialName} to the ${renovationType} surfaces.
${materialDesc ? `Material description: ${materialDesc}` : ''}
Keep everything else the same.
Output the modified texture image.`;
    }
    
    console.log('[Modify Texture] Prompt:', modificationPrompt.substring(0, 300) + '...');
    
    const model = genAI.getGenerativeModel({ 
      model: modelName,
      generationConfig: {
        responseMimeType: 'text/plain',
      },
    });
    
    // Send texture with modification prompt
    const result = await model.generateContent([
      {
        inlineData: {
          mimeType: mimeType,
          data: processedImageData,
        },
      },
      modificationPrompt,
    ]);
    
    const response = await result.response;
    
    // Check for generated image in response
    let generatedImage = null;
    
    if (response.candidates?.[0]?.content?.parts) {
      const parts = response.candidates[0].content.parts;
      
      for (const part of parts) {
        if (part.inlineData?.mimeType?.startsWith('image/')) {
          generatedImage = {
            imageData: part.inlineData.data,
            mimeType: part.inlineData.mimeType,
          };
          break;
        }
      }
    }
    
    if (!generatedImage) {
      // Try with Gemini 3 Pro Image (Nano Banana Pro) as fallback for higher quality
      console.log('[Modify Texture] No image from gemini-2.5-flash-image, trying gemini-3-pro-image-preview...');
      
      const proModel = genAI.getGenerativeModel({ 
        model: 'gemini-3-pro-image-preview',
        generationConfig: {
          responseMimeType: 'text/plain',
        },
      });
      const proResult = await proModel.generateContent([
        {
          inlineData: {
            mimeType: mimeType,
            data: processedImageData,
          },
        },
        modificationPrompt,
      ]);
      
      const proResponse = await proResult.response;
      
      if (proResponse.candidates?.[0]?.content?.parts) {
        const parts = proResponse.candidates[0].content.parts;
        for (const part of parts) {
          if (part.inlineData?.mimeType?.startsWith('image/')) {
            generatedImage = {
              imageData: part.inlineData.data,
              mimeType: part.inlineData.mimeType,
            };
            break;
          }
        }
      }
    }
    
    if (!generatedImage) {
      const textResponse = response.text?.() || 'No response';
      console.log('[Modify Texture] No image returned:', textResponse.substring(0, 300));
      
      return res.status(422).json({
        success: false,
        error: 'AI did not return a modified texture image',
        textResponse: textResponse.substring(0, 500),
      });
    }
    
    // Save the modified texture
    const filename = `modified_texture_${renovationType}_${renovationOption}_${Date.now()}.jpeg`;
    const filepath = path.join(TEXTURE_DIR, filename);
    
    let finalImageBuffer = Buffer.from(generatedImage.imageData, 'base64');
    let finalImageBase64 = generatedImage.imageData;
    let finalMimeType = generatedImage.mimeType;
    
    // Scale back up to original size if we resized earlier
    if (originalSize.width > MAX_TEXTURE_SIZE || originalSize.height > MAX_TEXTURE_SIZE) {
      console.log('[Modify Texture] Scaling result back to original size:', originalSize.width, 'x', originalSize.height);
      try {
        finalImageBuffer = await sharp(finalImageBuffer)
          .resize(originalSize.width, originalSize.height, {
            fit: 'fill',
          })
          .jpeg({ quality: 95 })
          .toBuffer();
        
        finalImageBase64 = finalImageBuffer.toString('base64');
        finalMimeType = 'image/jpeg';
        console.log('[Modify Texture] Scaled back up successfully');
      } catch (scaleError) {
        console.warn('[Modify Texture] Could not scale back up:', scaleError.message);
        // Continue with smaller image
      }
    }
    
    fs.writeFileSync(filepath, finalImageBuffer);
    
    console.log('[Modify Texture] ✅ Generated modified texture:', filename);
    
    res.json({
      success: true,
      modifiedTextureUrl: `/api/textures/${filename}`,
      modifiedTextureDataUrl: `data:${finalMimeType};base64,${finalImageBase64}`,
      renovationType,
      renovationOption,
    });
    
  } catch (error) {
    console.error('[Modify Texture] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      details: error.toString(),
    });
  }
});

