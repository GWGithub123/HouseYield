/**
 * Renovation Preview API Routes
 * Uses Google Gemini for AI-generated renovation visualizations
 */

import express from 'express';
import { randomUUID } from 'crypto';
import { GoogleGenerativeAI } from '@google/generative-ai';
import admin, { initializeFirebaseAdmin, getFirestore, requireAuth } from '../firebase-admin.js';

const router = express.Router();

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.Gemini_API_Key || process.env.GEMINI_API_KEY);
const PREVIEW_COLLECTION = 'renovationPreviews';

function getPreviewDb() {
  initializeFirebaseAdmin();
  return getFirestore();
}

function getPreviewBucket() {
  initializeFirebaseAdmin();
  return admin.storage().bucket();
}

function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') {
    throw new Error('Expected preview image data to be a base64 data URL');
  }

  const match = dataUrl.match(/^data:(.+?);base64,(.+)$/);
  if (!match) {
    throw new Error('Invalid preview image format; expected a base64 data URL');
  }

  return {
    contentType: match[1],
    buffer: Buffer.from(match[2], 'base64'),
  };
}

function buildFirebaseStorageDownloadUrl(bucketName, storagePath, token) {
  return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(storagePath)}?alt=media&token=${token}`;
}

async function uploadPreviewDataUrl({ dataUrl, storagePath, customMetadata = {} }) {
  const { contentType, buffer } = parseDataUrl(dataUrl);
  const bucket = getPreviewBucket();
  const downloadToken = randomUUID();
  const file = bucket.file(storagePath);

  await file.save(buffer, {
    resumable: false,
    metadata: {
      contentType,
      cacheControl: 'public,max-age=31536000',
      metadata: {
        ...customMetadata,
        firebaseStorageDownloadTokens: downloadToken,
      },
    },
  });

  return {
    downloadUrl: buildFirebaseStorageDownloadUrl(bucket.name, storagePath, downloadToken),
    storagePath,
  };
}

function buildCanonicalPreviewMetadata(suggestion = {}) {
  const canonicalResult = suggestion.canonicalResult || null;
  const canonicalContext = suggestion.canonicalContext || null;

  return {
    canonicalResultId: canonicalResult?.resultId || suggestion.id || null,
    canonicalPrimaryKey: canonicalResult?.primaryKey || canonicalContext?.primaryKey || null,
    canonicalSource: canonicalResult?.source || canonicalContext?.source || null,
    canonicalOpportunityId: canonicalResult?.canonicalOpportunityId || canonicalContext?.canonicalOpportunityId || null,
    canonicalRoomType: canonicalResult?.canonicalRoomType || canonicalContext?.canonicalRoomType || null,
    canonicalCategory: canonicalResult?.canonicalCategory || canonicalContext?.canonicalCategory || null,
    canonicalScopeType: canonicalResult?.canonicalScopeType || canonicalContext?.canonicalScopeType || null,
    canonicalMeasuredScope: canonicalResult?.measurementMatched ?? canonicalContext?.measurementMatched ?? null,
    canonicalTriggerFindingCount: canonicalResult?.triggerFindingCount ?? canonicalContext?.triggerFindingCount ?? null,
  };
}

async function uploadSuggestionPreviewImages({ userId, propertyId, suggestion, previewResult, originalImageUrls = [] }) {
  const timestamp = Date.now();
  const canonicalMetadata = buildCanonicalPreviewMetadata(suggestion);
  const suggestionId = suggestion?.id || canonicalMetadata.canonicalResultId || `preview-${timestamp}`;
  const suggestionName = suggestion?.name || '';

  const successPreviews = (previewResult?.previews || []).filter((preview) => preview.success && preview.previewImageUrl);
  const previewUploads = successPreviews.length > 0
    ? successPreviews.map((preview) => ({ index: preview.index, dataUrl: preview.previewImageUrl }))
    : previewResult?.previewImageUrl
      ? [{ index: 0, dataUrl: previewResult.previewImageUrl }]
      : [];

  const previewImages = [];
  for (const upload of previewUploads) {
    const storagePath = `renovation-previews/${userId}/${propertyId}/${suggestionId}_angle${upload.index}_${timestamp}.jpg`;
    const saved = await uploadPreviewDataUrl({
      dataUrl: upload.dataUrl,
      storagePath,
      customMetadata: {
        userId,
        propertyId,
        renovationId: suggestionId,
        renovationName: suggestionName,
        angleIndex: String(upload.index),
        canonicalResultId: canonicalMetadata.canonicalResultId || '',
        canonicalPrimaryKey: canonicalMetadata.canonicalPrimaryKey || '',
        canonicalOpportunityId: canonicalMetadata.canonicalOpportunityId || '',
      },
    });
    previewImages.push({ angleIndex: upload.index, ...saved });
  }

  const originalImages = [];
  for (let index = 0; index < Math.min(originalImageUrls.length, 4); index += 1) {
    const storagePath = `renovation-previews/${userId}/${propertyId}/${suggestionId}_original${index}_${timestamp}.jpg`;
    const saved = await uploadPreviewDataUrl({
      dataUrl: originalImageUrls[index],
      storagePath,
      customMetadata: {
        userId,
        propertyId,
        renovationId: suggestionId,
        renovationName: suggestionName,
        type: 'original',
        angleIndex: String(index),
        canonicalResultId: canonicalMetadata.canonicalResultId || '',
        canonicalPrimaryKey: canonicalMetadata.canonicalPrimaryKey || '',
        canonicalOpportunityId: canonicalMetadata.canonicalOpportunityId || '',
      },
    });
    originalImages.push({ angleIndex: index, ...saved });
  }

  return { previewImages, originalImages, canonicalMetadata };
}

function sortPreviewsDescendingByCreatedAt(previews) {
  return previews.sort((left, right) => {
    const leftTime = left?.createdAt ? new Date(left.createdAt).getTime() : 0;
    const rightTime = right?.createdAt ? new Date(right.createdAt).getTime() : 0;
    return rightTime - leftTime;
  });
}

function getAuthenticatedUserId(req) {
  return req.user?.uid || req.user?.user_id || null;
}

function ensurePreviewUserAccess(req, res, requestedUserId) {
  const authenticatedUserId = getAuthenticatedUserId(req);
  if (!authenticatedUserId || authenticatedUserId !== requestedUserId) {
    res.status(403).json({ ok: false, error: 'forbidden_preview_user_mismatch' });
    return false;
  }

  return true;
}

// ============================================================================
// Renovation Type Prompts
// ============================================================================

const RENOVATION_PROMPTS = {
  flooring: {
    hardwood: 'Replace the existing flooring with beautiful oak hardwood flooring with a natural matte finish',
    tile: 'Replace the existing flooring with modern large-format porcelain tile in a light gray color',
    carpet: 'Replace the existing flooring with plush neutral-toned wall-to-wall carpet',
    vinyl: 'Replace the existing flooring with luxury vinyl plank flooring in a weathered oak style',
    marble: 'Replace the existing flooring with elegant white marble tile with gray veining',
  },
  paint: {
    white: 'Repaint the walls in a clean bright white color',
    gray: 'Repaint the walls in a modern light gray color',
    beige: 'Repaint the walls in a warm beige/cream color',
    navy: 'Repaint the walls in a sophisticated navy blue color',
    sage: 'Repaint the walls in a calming sage green color',
  },
  countertop: {
    granite: 'Replace the countertops with polished black granite',
    quartz: 'Replace the countertops with white quartz with subtle gray veining',
    marble: 'Replace the countertops with Carrara marble',
    butcher_block: 'Replace the countertops with warm butcher block wood',
    laminate: 'Replace the countertops with modern white laminate',
  },
  fixtures: {
    vanity: 'Replace the vanity with a modern floating double-sink vanity in white with brushed nickel hardware',
    toilet: 'Replace the toilet with a modern comfort-height elongated toilet',
    faucet: 'Replace the faucets with modern brushed nickel fixtures',
    lighting: 'Replace the lighting with modern LED recessed lighting',
    shower: 'Replace the shower with a modern frameless glass shower enclosure',
  },
  kitchen: {
    cabinets: 'Replace the kitchen cabinets with modern white shaker-style cabinets',
    appliances: 'Replace the appliances with stainless steel modern appliances',
    backsplash: 'Add a white subway tile backsplash with dark grout',
  },
  general: {
    modern: 'Renovate this space with a modern contemporary style - clean lines, neutral colors, minimal decor',
    luxury: 'Renovate this space with a luxury high-end finish - premium materials, elegant fixtures',
    farmhouse: 'Renovate this space with a modern farmhouse style - shiplap, natural wood, vintage touches',
    minimalist: 'Renovate this space with a minimalist Scandinavian style - white walls, light wood, simple furniture',
  }
};

// ============================================================================
// Generate Renovation Preview (with actual image output using Nano Banana)
// ============================================================================

router.post('/generate', async (req, res) => {
  try {
    const { 
      imageData,           // Base64 image of current state
      image,               // Alternative key for imageData
      renovationType,      // 'flooring', 'paint', 'countertop', etc.
      renovationOption,    // 'hardwood', 'tile', 'white', etc.
      customPrompt,        // Optional: custom description
      description,         // Alternative to customPrompt (from live scanner)
      additionalPrompt,    // Additional context for the AI
      renovationId,        // ID of the detected renovation
      scanId,
      measurements,        // NEW: Actual room/object measurements from Metric3D
    } = req.body;
    
    // Support both imageData and image keys
    const imgData = imageData || image;
    
    if (!imgData) {
      return res.status(400).json({ error: 'Image data required' });
    }
    
    console.log('[Renovation Preview] 🎨 Generating preview with Gemini image generation...');
    console.log('[Renovation Preview] Type:', renovationType, '- Option:', renovationOption);
    if (measurements) {
      console.log('[Renovation Preview] 📐 Using real measurements from 3D scan');
    }
    
    // Build the prompt
    let prompt = customPrompt || description;
    if (!prompt && renovationType && renovationOption) {
      prompt = RENOVATION_PROMPTS[renovationType]?.[renovationOption];
    }
    if (!prompt) {
      prompt = renovationOption || renovationType || 'Show this room with modern renovations and updates';
    }
    
    // Add additional context if provided
    if (additionalPrompt) {
      prompt = `${prompt}\n\n${additionalPrompt}`;
    }
    
    // Add measurement context if available (for scaled/accurate previews)
    let measurementContext = '';
    if (measurements && measurements.room) {
      const lengthFt = (measurements.room.length * 3.28084).toFixed(1);
      const widthFt = (measurements.room.width * 3.28084).toFixed(1);
      const heightFt = (measurements.room.height * 3.28084).toFixed(1);
      measurementContext = `
ROOM MEASUREMENTS (use for accurate material scaling):
- Room is approximately ${lengthFt}' x ${widthFt}' with ${heightFt}' ceilings
- Ensure materials like tiles, planks, and fixtures appear at realistic scale relative to these dimensions
`;
      if (measurements.objects && measurements.objects.length > 0) {
        measurementContext += '\nOBJECT SIZES:\n';
        measurements.objects.forEach(obj => {
          const wFt = (obj.dimensions.width * 3.28084).toFixed(1);
          const hFt = (obj.dimensions.height * 3.28084).toFixed(1);
          measurementContext += `- ${obj.objectType}: ${wFt}' x ${hFt}'\n`;
        });
      }
    }

    const fullPrompt = `Edit this room image to apply the following renovation:

${prompt}
${measurementContext}
CRITICAL INSTRUCTIONS:
- Keep the EXACT same camera angle and perspective
- Keep the room layout and dimensions IDENTICAL  
- ONLY change the specific surfaces mentioned (floor/walls/ceiling)
- Keep ALL furniture, objects, and decorations in place
- Make the result look PHOTOREALISTIC and natural
- Ensure lighting is consistent with the new materials
- The renovation should look professionally installed
${measurementContext ? '- Scale materials appropriately based on room measurements (e.g., tiles should be realistic size relative to room)' : ''}`;

    // Extract base64 data
    const base64Data = imgData.replace(/^data:image\/\w+;base64,/, '');
    
    // Use Gemini 2.5 Flash Image (Nano Banana) for image generation
    const modelName = 'gemini-2.5-flash-image';
    console.log('[Renovation Preview] Using model:', modelName);
    
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      
      const result = await model.generateContent({
        contents: [{
          role: 'user',
          parts: [
            { text: fullPrompt },
            {
              inlineData: {
                mimeType: 'image/jpeg',
                data: base64Data
              }
            }
          ]
        }],
        generationConfig: {
          responseModalities: ['image', 'text'],
        }
      });
      
      const response = await result.response;
      
      // Check if we got an image back
      const parts = response.candidates?.[0]?.content?.parts || [];
      let generatedImage = null;
      let textResponse = '';
      
      for (const part of parts) {
        if (part.inlineData) {
          generatedImage = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
          console.log('[Renovation Preview] ✅ Got image from Gemini!');
        }
        if (part.text) {
          textResponse = part.text;
        }
      }
      
      if (generatedImage) {
        console.log('[Renovation Preview] ✅ Generated image successfully');
        return res.json({
          success: true,
          imageUrl: generatedImage,  // For consistency with what the frontend expects
          generatedImageUrl: generatedImage,
          description: textResponse,
          renovationType,
          renovationOption,
          timestamp: new Date().toISOString(),
          scanId,
          renovationId,
        });
      }
      
      // Try fallback model if no image
      console.log('[Renovation Preview] ⚠️ No image from Nano Banana, trying gemini-3-pro-image-preview...');
      
    } catch (nanoBananaError) {
      console.log('[Renovation Preview] Nano Banana error:', nanoBananaError.message);
    }
    
    // Fallback to gemini-3-pro-image-preview (Nano Banana Pro)
    try {
      const fallbackModel = genAI.getGenerativeModel({ model: 'gemini-3-pro-image-preview' });
      
      const result = await fallbackModel.generateContent({
        contents: [{
          role: 'user',
          parts: [
            { text: fullPrompt },
            {
              inlineData: {
                mimeType: 'image/jpeg',
                data: base64Data
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
      let generatedImage = null;
      let textResponse = '';
      
      for (const part of parts) {
        if (part.inlineData) {
          generatedImage = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
        }
        if (part.text) {
          textResponse = part.text;
        }
      }
      
      if (generatedImage) {
        console.log('[Renovation Preview] ✅ Generated image with fallback model');
        return res.json({
          success: true,
          imageUrl: generatedImage,
          generatedImageUrl: generatedImage,
          description: textResponse,
          renovationType,
          renovationOption,
          timestamp: new Date().toISOString(),
          scanId,
          renovationId,
        });
      }
      
      // No image generated
      return res.json({
        success: false,
        error: 'Image generation not available - models did not return an image',
        description: textResponse || 'Unable to generate renovation preview image',
      });
      
    } catch (fallbackError) {
      console.error('[Renovation Preview] Fallback also failed:', fallbackError.message);
      throw fallbackError;
    }
    
  } catch (error) {
    console.error('[Renovation Preview] Error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to generate renovation preview',
      details: error.message 
    });
  }
});

// ============================================================================
// Generate Image with Gemini Imagen (if available)
// ============================================================================

router.post('/generate-image', async (req, res) => {
  try {
    const { 
      imageData,
      renovationType,
      renovationOption,
      customPrompt,
      scanId,
    } = req.body;
    
    if (!imageData) {
      return res.status(400).json({ error: 'Image data required' });
    }
    
    console.log('[Renovation Preview] 🖼️ Generating image preview...');
    
    // Build the prompt for image editing
    let editPrompt = customPrompt;
    if (!editPrompt && renovationType && renovationOption) {
      editPrompt = RENOVATION_PROMPTS[renovationType]?.[renovationOption];
    }
    if (!editPrompt) {
      editPrompt = 'Renovate this room with modern updates';
    }
    
    const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
    
    // Use Gemini image-generation model (Nano Banana)
    try {
      const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-image' });
      
      const result = await model.generateContent({
        contents: [{
          role: 'user',
          parts: [
            { 
              text: `Edit this room image to: ${editPrompt}. 
                     Keep the same camera angle and room layout.
                     Make it look photorealistic.` 
            },
            {
              inlineData: {
                mimeType: 'image/jpeg',
                data: base64Data
              }
            }
          ]
        }],
        generationConfig: {
          responseModalities: ['image', 'text'],
        }
      });
      
      const response = await result.response;
      
      // Check if we got an image back
      const parts = response.candidates?.[0]?.content?.parts || [];
      let generatedImage = null;
      let textResponse = '';
      
      for (const part of parts) {
        if (part.inlineData) {
          generatedImage = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
        }
        if (part.text) {
          textResponse = part.text;
        }
      }
      
      if (generatedImage) {
        console.log('[Renovation Preview] ✅ Generated image successfully');
        return res.json({
          success: true,
          generatedImageUrl: generatedImage,
          description: textResponse,
          renovationType,
          renovationOption,
        });
      }
      
      // Fall back to description only
      console.log('[Renovation Preview] ⚠️ No image generated, returning description only');
      return res.json({
        success: true,
        generatedImageUrl: null,
        description: textResponse || 'Image generation not available, but renovation would include: ' + editPrompt,
        renovationType,
        renovationOption,
        note: 'Image generation not available with current API configuration'
      });
      
    } catch (imagenError) {
      console.log('[Renovation Preview] Imagen not available:', imagenError.message);
      
      // Fall back to description-only with regular Gemini
      const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
      
      const result = await model.generateContent([
        `Describe in vivid detail what this room would look like after the following renovation: ${editPrompt}. 
         Include specific materials, colors, textures, and how the light would interact with the new surfaces.`,
        {
          inlineData: {
            mimeType: 'image/jpeg',
            data: base64Data
          }
        }
      ]);
      
      const response = await result.response;
      
      return res.json({
        success: true,
        generatedImageUrl: null,
        description: response.text(),
        renovationType,
        renovationOption,
        note: 'AI-generated image not available. Showing detailed description instead.'
      });
    }
    
  } catch (error) {
    console.error('[Renovation Preview] Error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to generate renovation image',
      details: error.message 
    });
  }
});

// ============================================================================
// Get Available Renovation Options
// ============================================================================

router.get('/options', (req, res) => {
  res.json({
    success: true,
    options: Object.entries(RENOVATION_PROMPTS).map(([category, options]) => ({
      category,
      options: Object.keys(options)
    }))
  });
});

// ============================================================================
// ENHANCED TILE: Contextual Floor Generation with Pattern Extraction
// This endpoint:
// 1. Takes a top-down room image
// 2. Uses Gemini to add realistic flooring to the room context
// 3. Extracts a tileable pattern section from the generated floor
// 4. Returns both the contextual image and the extracted pattern
// ============================================================================

router.post('/generate-contextual-floor', async (req, res) => {
  try {
    const {
      roomImageBase64,      // Top-down image of the room
      materialType,         // 'flooring'
      materialOption,       // 'hardwood', 'oak', 'walnut', 'vinyl', etc.
      roomDimensions,       // { widthMeters, lengthMeters }
      plankSpecs,           // { plankWidthInches, plankLengthInches, grainDirection, staggerPattern }
      plankLayout,          // { planksAcrossWidth, planksAcrossLength, ... }
      extractPattern = true,
    } = req.body;
    
    console.log('[Contextual Floor] 🎨 Generating contextual floor with pattern extraction...');
    console.log('[Contextual Floor] Material:', materialType, '-', materialOption);
    console.log('[Contextual Floor] Room dimensions:', roomDimensions?.widthMeters?.toFixed(2), 'x', 
                roomDimensions?.lengthMeters?.toFixed(2), 'm');
    console.log('[Contextual Floor] Plank specs:', plankSpecs);
    console.log('[Contextual Floor] Has room image:', !!roomImageBase64);
    
    // If no room image provided, generate a standalone seamless tile directly
    const hasRoomImage = roomImageBase64 && roomImageBase64.length > 100;
    
    // Build detailed material descriptions
    const materialDescriptions = {
      hardwood: 'oak hardwood flooring with natural wood grain, warm medium-brown tones, subtle knots, 5-inch wide planks running horizontally',
      oak: 'natural oak hardwood planks with golden-honey tones and visible grain patterns, 5-inch wide planks with beveled edges',
      walnut: 'rich dark walnut hardwood planks with deep chocolate-brown tones and subtle purple undertones, 6-inch wide planks',
      'light-oak': 'light blonde oak hardwood planks with pale golden tones, Scandinavian style, 5-inch wide planks',
      'gray-wash': 'gray-washed oak hardwood with weathered whitewash finish, coastal style, 6-inch wide planks',
      vinyl: 'luxury vinyl plank flooring in weathered gray oak style with realistic wood texture, 7-inch wide planks',
      lvp: 'luxury vinyl plank in light gray with subtle grain texture, waterproof finish, 7-inch wide planks',
      tile: 'large format porcelain floor tiles in light gray, 24x24 inch squares with thin grout lines',
      porcelain: 'white polished porcelain tiles with subtle marble veining, 24x24 inch squares',
      bamboo: 'natural bamboo flooring with distinctive horizontal grain, light golden color, 4-inch wide planks',
      engineered: 'engineered hardwood in medium brown with oak veneer, 6-inch wide planks with tongue-and-groove',
    };
    
    const materialDesc = materialDescriptions[materialOption.toLowerCase()] || 
                        `${materialOption} ${materialType} flooring`;
    
    // Calculate plank info for the prompt
    const plankWidth = plankSpecs?.plankWidthInches || 5;
    const plankLength = plankSpecs?.plankLengthInches || 48;
    const staggerPattern = plankSpecs?.staggerPattern || 'random';
    
    // Step 1: Generate the floor ON the room image
    const contextualPrompt = `This is a top-down view of a room. Replace ALL existing flooring in this image with ${materialDesc}.

FLOORING SPECIFICATIONS:
- Plank width: ${plankWidth} inches (approximately ${(plankWidth * 2.54 / 100).toFixed(2)} meters)
- Plank length: ${plankLength} inches (approximately ${(plankLength * 2.54 / 100).toFixed(2)} meters)
- Stagger pattern: ${staggerPattern}
- Room size: ${roomDimensions?.widthMeters?.toFixed(1) || '3'}m × ${roomDimensions?.lengthMeters?.toFixed(1) || '4'}m
- Show approximately ${plankLayout?.planksAcrossWidth || 8} plank rows across the width

CRITICAL REQUIREMENTS:
- Keep all furniture, walls, and objects EXACTLY as they are - only change the floor
- The flooring must look completely realistic and properly installed
- Show proper plank stagger pattern with realistic joint offsets
- Natural lighting and perspective must be preserved
- The floor planks should be correctly sized relative to the room
- Show subtle variation in wood grain between planks
- Include realistic plank end joints where boards meet`;

    // Use Gemini 2.5 Flash Image (Nano Banana) for image generation
    const modelName = 'gemini-2.5-flash-image';
    let generatedRoomImageUrl = null;
    let tileTextureUrl = null;
    let extractedPatternUrl = null;
    
    // STEP 1: If we have a room image, generate floor in context
    if (hasRoomImage) {
      console.log('[Contextual Floor] Sending room image to Gemini for floor generation...');
      
      // Extract base64 data from data URL if present
      let imageBase64 = roomImageBase64;
      let imageMimeType = 'image/jpeg';
      
      if (roomImageBase64.startsWith('data:')) {
        const matches = roomImageBase64.match(/^data:([^;]+);base64,(.+)$/);
        if (matches) {
          imageMimeType = matches[1];
          imageBase64 = matches[2];
        }
      }
      
      try {
        const model = genAI.getGenerativeModel({ model: modelName });
        console.log('[Contextual Floor] Using model:', modelName);
        
        const result = await model.generateContent({
          contents: [{
            role: 'user',
            parts: [
              { 
                inlineData: {
                  mimeType: imageMimeType,
                  data: imageBase64,
                }
              },
              { text: contextualPrompt }
            ]
          }],
          generationConfig: {
            responseModalities: ['image', 'text'],
          }
        });
        
        const response = await result.response;
        const parts = response.candidates?.[0]?.content?.parts || [];
        
        console.log('[Contextual Floor] Response parts count:', parts.length);
        
        let foundImage = false;
        for (const part of parts) {
          if (part.inlineData) {
            generatedRoomImageUrl = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
            console.log('[Contextual Floor] ✅ Generated room with new floor! Size:', part.inlineData.data.length);
            foundImage = true;
            break;
          } else if (part.text) {
            console.log('[Contextual Floor] Got text response:', part.text.substring(0, 200));
          }
        }
        
        if (!foundImage) {
          console.warn('[Contextual Floor] ⚠️ No image in Gemini response - may have returned text only');
        }
      } catch (geminiError) {
        console.error('[Contextual Floor] ❌ Gemini error on room generation:', geminiError.message);
        console.error('[Contextual Floor] Full error:', geminiError);
      }
      
      // Step 2: Extract a tileable pattern from the generated image
      if (generatedRoomImageUrl && extractPattern) {
        console.log('[Contextual Floor] Extracting tileable pattern from generated floor...');
        
        // Extract base64 from the generated image
        let generatedBase64 = generatedRoomImageUrl;
        let generatedMimeType = 'image/png';
        
        if (generatedRoomImageUrl.startsWith('data:')) {
          const matches = generatedRoomImageUrl.match(/^data:([^;]+);base64,(.+)$/);
          if (matches) {
            generatedMimeType = matches[1];
            generatedBase64 = matches[2];
          }
        }
      
        const extractionPrompt = `This is a room image with ${materialDesc} flooring installed.

TASK: Extract a perfectly seamless TILEABLE TEXTURE from the floor in this image.

REQUIREMENTS:
- Extract ONLY the flooring texture - no furniture, walls, shadows, or other objects
- The extracted texture MUST tile seamlessly - left edge matches right, top matches bottom
- Maintain the exact same wood grain pattern and color from the installed floor
- The texture should show approximately 2-3 plank widths for proper tiling
- Top-down orthographic view with no perspective distortion
- Even lighting with no shadows or hotspots
- Output should be a clean, isolated texture sample

Generate a new image that is ONLY the extracted seamless flooring texture.`;

      try {
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-image' });
        
        const extractResult = await model.generateContent({
          contents: [{
            role: 'user',
            parts: [
              {
                inlineData: {
                  mimeType: generatedMimeType,
                  data: generatedBase64,
                }
              },
              { text: extractionPrompt }
            ]
          }],
          generationConfig: {
            responseModalities: ['image', 'text'],
          }
        });
        
        const extractResponse = await extractResult.response;
        const extractParts = extractResponse.candidates?.[0]?.content?.parts || [];
        
        for (const part of extractParts) {
          if (part.inlineData) {
            extractedPatternUrl = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
            tileTextureUrl = extractedPatternUrl; // Use extracted pattern as tile
            console.log('[Contextual Floor] ✅ Extracted tileable pattern!');
            break;
          }
        }
      } catch (extractError) {
        console.error('[Contextual Floor] Pattern extraction error:', extractError.message);
      }
    }
    } // End of if (hasRoomImage)
    
    // Fallback: Generate a standalone seamless tile if extraction failed
    if (!tileTextureUrl) {
      console.log('[Contextual Floor] Falling back to standalone tile generation...');
      
      const fallbackPrompt = `Generate a perfectly seamless tileable texture of ${materialDesc}.

CRITICAL REQUIREMENTS:
- The texture MUST tile seamlessly - left edge matches right edge, top edge matches bottom edge
- Top-down orthographic view, no perspective distortion
- Show 2-3 plank widths and 1-2 plank lengths
- Even, diffuse lighting with NO shadows
- No edge artifacts or visible seams when tiled
- Photorealistic quality with natural wood grain variation
- Do NOT include any room context, furniture, or objects
- ONLY show the material surface itself
- Plank width: approximately ${plankWidth} inches`;

      try {
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-image' });
        
        const fallbackResult = await model.generateContent({
          contents: [{
            role: 'user',
            parts: [{ text: fallbackPrompt }]
          }],
          generationConfig: {
            responseModalities: ['image', 'text'],
          }
        });
        
        const fallbackResponse = await fallbackResult.response;
        const fallbackParts = fallbackResponse.candidates?.[0]?.content?.parts || [];
        
        for (const part of fallbackParts) {
          if (part.inlineData) {
            tileTextureUrl = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
            console.log('[Contextual Floor] ✅ Generated fallback tile texture!');
            break;
          }
        }
      } catch (fallbackError) {
        console.error('[Contextual Floor] Fallback tile generation error:', fallbackError.message);
      }
    }
    
    // Final fallback: procedural color
    if (!tileTextureUrl) {
      console.log('[Contextual Floor] Using color fallback...');
      
      const fallbackColors = {
        hardwood: '#9C7A4A',
        oak: '#C9A66B',
        walnut: '#5C4033',
        'light-oak': '#DEB887',
        'gray-wash': '#A0A0A0',
        vinyl: '#B8A080',
        lvp: '#C8C0B0',
        tile: '#E0E0E0',
        porcelain: '#F5F5F5',
        bamboo: '#D4B896',
        engineered: '#A88860',
      };
      
      const color = fallbackColors[materialOption.toLowerCase()] || '#9C7A4A';
      
      return res.json({
        success: true,
        generatedRoomImageUrl,
        extractedPatternUrl: null,
        tileTextureUrl: null,
        fallbackColor: color,
        materialType,
        materialOption,
        plankSpecs,
        message: 'Used color fallback - Gemini could not generate images',
        timestamp: new Date().toISOString(),
      });
    }
    
    // Success response
    return res.json({
      success: true,
      generatedRoomImageUrl,
      extractedPatternUrl,
      tileTextureUrl,
      materialType,
      materialOption,
      plankSpecs,
      plankLayout,
      timestamp: new Date().toISOString(),
    });
    
  } catch (error) {
    console.error('[Contextual Floor] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to generate contextual floor',
    });
  }
});

// ============================================================================
// AI FLOOR OUTLINE: GPT-4o Vision draws floor outline using a virtual tool
// The AI analyzes the overhead view and returns polygon coordinates
// outlining exactly where the floor is. This is displayed as a lime green
// outline on the 3D mesh.
// ============================================================================

router.post('/ai-floor-outline', async (req, res) => {
  try {
    const { imageBase64 } = req.body;
    
    console.log('[AI Floor Outline] 🖍️ GPT-4o Vision is outlining the floor...');
    
    if (!imageBase64) {
      return res.status(400).json({
        success: false,
        error: 'imageBase64 is required',
      });
    }
    
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      return res.status(500).json({
        success: false,
        error: 'OpenAI API key not configured',
      });
    }
    
    // Extract base64 data
    let base64Data = imageBase64;
    let mimeType = 'image/jpeg';
    
    if (imageBase64.startsWith('data:')) {
      const matches = imageBase64.match(/^data:([^;]+);base64,(.+)$/);
      if (matches) {
        mimeType = matches[1];
        base64Data = matches[2];
      }
    }
    
    // Prompt for GPT-4o Vision to act as an outline tool
    const outlinePrompt = `You are an AI assistant with access to a POLYGON OUTLINE TOOL. Your task is to carefully trace the visible FLOOR area in this overhead/top-down view of a room.

USING THE OUTLINE TOOL:
- You will draw polygon(s) by specifying vertex coordinates
- Coordinates are NORMALIZED (0 to 1), where (0,0) is TOP-LEFT and (1,1) is BOTTOM-RIGHT
- Trace the perimeter of ONLY the actual floor surface
- Be precise - follow the edges carefully

WHAT IS FLOOR:
✅ Walkable ground surface (hardwood, carpet, tile, concrete)
✅ Area rugs on the floor (they're on top of floor)
✅ Shadows on the floor (still floor underneath)

WHAT IS NOT FLOOR (do NOT include):
❌ Furniture surfaces (beds, tables, chairs, desks, couches)
❌ Cabinets, appliances, bathroom fixtures
❌ Walls, baseboards
❌ Any vertical surfaces
❌ Items sitting on the floor (boxes, clothes, objects)

INSTRUCTIONS:
1. Identify all visible floor regions
2. For each region, trace its outline as a polygon with vertices
3. Use enough vertices to capture the shape accurately (typically 6-20 per polygon)
4. Return the coordinates as JSON

OUTPUT FORMAT (JSON only, no markdown):
{
  "polygons": [
    {
      "vertices": [
        {"x": 0.1, "y": 0.3},
        {"x": 0.4, "y": 0.25},
        {"x": 0.5, "y": 0.6},
        {"x": 0.2, "y": 0.7}
      ],
      "description": "main floor area near center"
    }
  ],
  "confidence": 0.85,
  "description": "Traced floor outline avoiding the bed and furniture"
}

Now analyze this image and use the outline tool to trace all visible floor areas.`;

    console.log('[AI Floor Outline] Sending to GPT-4o Vision...');
    
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: {
                  url: `data:${mimeType};base64,${base64Data}`,
                  detail: 'high',
                },
              },
              {
                type: 'text',
                text: outlinePrompt,
              },
            ],
          },
        ],
        max_tokens: 2000,
        temperature: 0.2,  // Low temperature for precise coordinates
      }),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('[AI Floor Outline] OpenAI API error:', response.status, errorText);
      throw new Error(`OpenAI API error: ${response.status}`);
    }
    
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    
    console.log('[AI Floor Outline] GPT-4o response:', content.substring(0, 500));
    
    // Parse JSON from response
    let result;
    try {
      // Try to extract JSON from the response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        result = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in response');
      }
    } catch (parseError) {
      console.error('[AI Floor Outline] Failed to parse response:', parseError);
      return res.json({
        success: false,
        error: 'Failed to parse AI response',
        rawResponse: content,
      });
    }
    
    // Validate and format polygons
    const polygons = [];
    if (result.polygons && Array.isArray(result.polygons)) {
      for (const polygon of result.polygons) {
        if (polygon.vertices && Array.isArray(polygon.vertices)) {
          const validVertices = polygon.vertices.filter(v => 
            typeof v.x === 'number' && typeof v.y === 'number' &&
            v.x >= 0 && v.x <= 1 && v.y >= 0 && v.y <= 1
          );
          
          if (validVertices.length >= 3) {
            polygons.push(validVertices);
          }
        }
      }
    }
    
    console.log('[AI Floor Outline] ✅ Parsed', polygons.length, 'valid polygon(s)');
    console.log('[AI Floor Outline] Total vertices:', polygons.reduce((sum, p) => sum + p.length, 0));
    
    res.json({
      success: true,
      polygons,
      confidence: result.confidence || 0.8,
      description: result.description || 'Floor outline generated by AI',
    });
    
  } catch (error) {
    console.error('[AI Floor Outline] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to generate floor outline',
    });
  }
});

// ============================================================================
// VISION FLOOR MASK: AI-powered floor region identification
// Uses Gemini vision to analyze a top-down view and identify exactly
// which areas are floor vs furniture/objects. Returns a binary mask.
// ============================================================================

router.post('/analyze-floor-mask', async (req, res) => {
  try {
    const {
      topDownImageBase64,
      roomContext,
      returnMaskImage = true,
    } = req.body;
    
    console.log('[Floor Mask] 🎯 Analyzing top-down image for floor regions...');
    
    if (!topDownImageBase64) {
      return res.status(400).json({
        success: false,
        error: 'topDownImageBase64 is required',
      });
    }
    
    // Extract base64 data
    let imageBase64 = topDownImageBase64;
    let imageMimeType = 'image/jpeg';
    
    if (topDownImageBase64.startsWith('data:')) {
      const matches = topDownImageBase64.match(/^data:([^;]+);base64,(.+)$/);
      if (matches) {
        imageMimeType = matches[1];
        imageBase64 = matches[2];
      }
    }
    
    // Prompt for floor identification
    const maskPrompt = `Analyze this top-down view of a room and create a BINARY MASK image showing where the FLOOR is.

TASK: Generate a new image that is a BLACK AND WHITE MASK where:
- WHITE (255, 255, 255) = Areas that are FLOOR (walkable ground surface)
- BLACK (0, 0, 0) = Areas that are NOT floor (furniture, bed, dresser, chairs, tables, rugs, objects, people, pets, shadows on non-floor surfaces)

CRITICAL RULES:
1. ONLY the actual floor surface should be white
2. Furniture tops, bed surfaces, table tops should be BLACK (not floor!)
3. Any object sitting ON the floor should be BLACK
4. Shadows on the floor are still floor (WHITE)
5. Area rugs can be considered floor (WHITE) unless they're on furniture
6. Wall edges and corners that touch the floor should have clean boundaries
7. The mask should have the SAME dimensions and perspective as the input image

The output should be a clean binary mask image with no gradients - pure black and white only.

Generate the floor mask image now.`;

    let maskImageUrl = null;
    let floorRegions = [];
    let confidence = 0;
    
    try {
      const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-image' });
      
      console.log('[Floor Mask] Sending to Gemini for mask generation...');
      
      const result = await model.generateContent({
        contents: [{
          role: 'user',
          parts: [
            {
              inlineData: {
                mimeType: imageMimeType,
                data: imageBase64,
              }
            },
            { text: maskPrompt }
          ]
        }],
        generationConfig: {
          responseModalities: ['image', 'text'],
        }
      });
      
      const response = await result.response;
      const parts = response.candidates?.[0]?.content?.parts || [];
      
      for (const part of parts) {
        if (part.inlineData) {
          maskImageUrl = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
          console.log('[Floor Mask] ✅ Generated floor mask! Size:', part.inlineData.data.length);
          confidence = 0.85;
          break;
        } else if (part.text) {
          console.log('[Floor Mask] Got text response:', part.text.substring(0, 200));
        }
      }
    } catch (geminiError) {
      console.error('[Floor Mask] ❌ Gemini error:', geminiError.message);
    }
    
    // Fallback: Ask Gemini to describe floor regions if mask generation failed
    if (!maskImageUrl) {
      console.log('[Floor Mask] Mask generation failed, trying region description...');
      
      try {
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
        
        const regionPrompt = `Analyze this top-down view of a room. Identify WHERE THE FLOOR IS VISIBLE.

Describe the floor regions as normalized coordinates (0-1 range, where 0,0 is top-left and 1,1 is bottom-right).

Return a JSON object with this structure:
{
  "floorRegions": [
    {
      "description": "main floor area",
      "vertices": [
        { "x": 0.0, "y": 0.5 },
        { "x": 0.3, "y": 0.8 },
        { "x": 0.7, "y": 0.9 },
        { "x": 0.8, "y": 0.4 }
      ],
      "confidence": 0.9
    }
  ],
  "furnitureRegions": [
    { "description": "bed in center", "bounds": { "x": 0.2, "y": 0.2, "width": 0.5, "height": 0.4 } }
  ],
  "overallConfidence": 0.85
}

Be precise about where visible floor exists vs where furniture covers it.`;

        const regionResult = await model.generateContent({
          contents: [{
            role: 'user',
            parts: [
              {
                inlineData: {
                  mimeType: imageMimeType,
                  data: imageBase64,
                }
              },
              { text: regionPrompt }
            ]
          }]
        });
        
        const regionResponse = await regionResult.response;
        const regionText = regionResponse.text();
        
        // Parse JSON from response
        const jsonMatch = regionText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          floorRegions = parsed.floorRegions || [];
          confidence = parsed.overallConfidence || 0.7;
          console.log('[Floor Mask] ✅ Got floor regions description:', floorRegions.length, 'regions');
        }
      } catch (regionError) {
        console.error('[Floor Mask] ❌ Region description error:', regionError.message);
      }
    }
    
    if (!maskImageUrl && floorRegions.length === 0) {
      return res.status(500).json({
        success: false,
        error: 'Could not analyze floor regions',
      });
    }
    
    return res.json({
      success: true,
      maskImageUrl,
      floorRegions,
      confidence,
      timestamp: new Date().toISOString(),
    });
    
  } catch (error) {
    console.error('[Floor Mask] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to analyze floor mask',
    });
  }
});

// ============================================================================
// Seamless Tile Texture Generation (for Triplanar Renovation)
// Generates a perfectly seamless tileable texture for 3D mesh application
// ============================================================================

router.post('/generate-tile-texture', async (req, res) => {
  try {
    const {
      materialType,
      materialOption,
      tileSizeMeters = { width: 1.0, height: 1.0 },
      seamless = true,
    } = req.body;
    
    console.log('[Tile Texture] 🎨 Generating seamless tile texture for triplanar projection...');
    console.log('[Tile Texture] Material:', materialType, '-', materialOption);
    console.log('[Tile Texture] Tile size:', tileSizeMeters.width, 'x', tileSizeMeters.height, 'm');
    
    // Build a prompt optimized for seamless tileable textures
    const materialDescriptions = {
      flooring: {
        hardwood: 'oak hardwood flooring planks with natural wood grain, warm medium brown tones, subtle knots',
        walnut: 'rich dark walnut hardwood planks with deep brown tones and subtle grain patterns',
        'light-oak': 'light natural oak hardwood planks with pale golden tones and visible grain',
        tile: 'large format porcelain floor tiles in light gray with subtle texture',
        marble: 'white Carrara marble with elegant gray veining',
        vinyl: 'luxury vinyl plank flooring in weathered gray oak style',
        carpet: 'neutral beige plush carpet texture with soft fiber appearance',
        concrete: 'polished concrete floor with subtle aggregate visible',
        bamboo: 'natural bamboo flooring with distinctive knuckle pattern',
      },
      paint: {
        white: 'smooth matte white painted surface with very subtle texture',
        gray: 'modern light gray painted surface with eggshell finish',
        beige: 'warm beige painted surface with subtle warmth',
        navy: 'rich navy blue painted surface with slight sheen',
        sage: 'calming sage green painted surface with natural undertones',
        cream: 'warm cream colored painted surface',
        charcoal: 'deep charcoal gray painted surface',
      },
      tile: {
        subway: 'white subway tiles with thin gray grout lines arranged in brick pattern',
        hexagon: 'white hexagonal tiles with gray grout',
        moroccan: 'blue and white Moroccan patterned tiles',
        terracotta: 'warm terracotta clay tiles with natural variation',
      },
      wallpaper: {
        geometric: 'modern geometric pattern wallpaper in navy and gold',
        floral: 'elegant subtle floral pattern wallpaper in muted tones',
        textured: 'textured grasscloth wallpaper in natural beige',
      }
    };
    
    const materialDesc = materialDescriptions[materialType]?.[materialOption] 
      || `${materialOption} ${materialType}`;
    
    const fullPrompt = `Generate a perfectly seamless tileable texture of ${materialDesc}.

CRITICAL REQUIREMENTS:
- The texture MUST tile seamlessly - left edge matches right edge, top edge matches bottom edge
- Top-down orthographic view, no perspective distortion
- Even, diffuse lighting with NO shadows
- No edge artifacts or visible seams when tiled
- Photorealistic quality with natural material variation
- Do NOT include any room context, furniture, or objects
- ONLY show the material surface itself

The texture represents a ${tileSizeMeters.width}m × ${tileSizeMeters.height}m section of ${materialOption} ${materialType}.`;

    // Use Gemini 2.5 Flash Image
    const modelName = 'gemini-2.5-flash-image';
    
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      
      const result = await model.generateContent({
        contents: [{
          role: 'user',
          parts: [{ text: fullPrompt }]
        }],
        generationConfig: {
          responseModalities: ['image', 'text'],
        }
      });
      
      const response = await result.response;
      const parts = response.candidates?.[0]?.content?.parts || [];
      
      let generatedImage = null;
      
      for (const part of parts) {
        if (part.inlineData) {
          generatedImage = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
          console.log('[Tile Texture] ✅ Seamless tile generated successfully!');
          
          return res.json({
            success: true,
            textureUrl: generatedImage,
            materialType,
            materialOption,
            tileSizeMeters,
            timestamp: new Date().toISOString(),
          });
        }
      }
      
      console.log('[Tile Texture] ⚠️ No image generated, using fallback...');
      
    } catch (geminiError) {
      console.error('[Tile Texture] Gemini error:', geminiError.message);
    }
    
    // Fallback: Return built-in texture URLs or procedural generation params
    const fallbackTextures = {
      flooring: {
        hardwood: '/textures/defaults/oak-hardwood.jpg',
        walnut: '/textures/defaults/walnut-hardwood.jpg',
        tile: '/textures/defaults/gray-tile.jpg',
      },
      paint: {
        white: null,  // Use color
        gray: null,
        beige: null,
      }
    };
    
    const fallbackColors = {
      flooring: {
        hardwood: '#9C7A4A',
        walnut: '#5C4033',
        tile: '#D3D3D3',
        marble: '#F0F0F0',
        carpet: '#C4B8A8',
      },
      paint: {
        white: '#FAFAFA',
        gray: '#9CA3AF',
        beige: '#D4C8B8',
        navy: '#1E3A5F',
        sage: '#87A878',
        cream: '#F5F0E1',
      }
    };
    
    const fallbackTextureUrl = fallbackTextures[materialType]?.[materialOption];
    const fallbackColor = fallbackColors[materialType]?.[materialOption] || '#C4B8A8';
    
    return res.json({
      success: true,
      textureUrl: fallbackTextureUrl,
      fallbackColor: fallbackTextureUrl ? null : fallbackColor,
      materialType,
      materialOption,
      tileSizeMeters,
      usedFallback: true,
      timestamp: new Date().toISOString(),
    });
    
  } catch (error) {
    console.error('[Tile Texture] Error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to generate tile texture' 
    });
  }
});

// ============================================================================
// Material Tile Generation Endpoint (LEGACY - kept for compatibility)
// Generates a seamless tileable material texture using Gemini
// ============================================================================

router.post('/generate-material-tile', async (req, res) => {
  try {
    const {
      prompt,
      materialType,
      materialOption,
      tileSize = 512,
    } = req.body;
    
    console.log('[Material Tile] 🎨 Generating seamless material tile...');
    console.log('[Material Tile] Type:', materialType, '- Option:', materialOption);
    
    const fullPrompt = prompt || `Generate a seamless tileable ${materialOption} ${materialType} texture, photorealistic, even lighting, no shadows, top-down view`;
    
    // Use Gemini 2.5 Flash Image for best quality
    const modelName = 'gemini-2.5-flash-image';
    
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      
      const result = await model.generateContent({
        contents: [{
          role: 'user',
          parts: [{ text: fullPrompt }]
        }],
        generationConfig: {
          responseModalities: ['image', 'text'],
        }
      });
      
      const response = await result.response;
      const parts = response.candidates?.[0]?.content?.parts || [];
      
      let generatedImage = null;
      
      for (const part of parts) {
        if (part.inlineData) {
          generatedImage = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
          console.log('[Material Tile] ✅ Tile generated successfully!');
        }
      }
      
      if (generatedImage) {
        return res.json({
          success: true,
          tileUrl: generatedImage,
          materialType,
          materialOption,
          timestamp: new Date().toISOString(),
        });
      }
      
      console.log('[Material Tile] ⚠️ No image from Gemini, trying fallback...');
      
    } catch (geminiError) {
      console.log('[Material Tile] Gemini error:', geminiError.message);
    }
    
    // Fallback: Return a placeholder tile URL (client will need to handle this)
    console.log('[Material Tile] Using fallback - returning error for client to handle');
    
    // Material-specific placeholder colors for client-side generation
    const materialColors = {
      flooring: {
        hardwood: '#8B7355',
        walnut: '#5C4033',
        tile: '#D3D3D3',
        marble: '#F5F5F5',
        vinyl: '#A89880',
        carpet: '#C4B8A8',
      },
      paint: {
        white: '#FAFAFA',
        gray: '#B0B0B0',
        beige: '#D4C8B8',
        navy: '#2C3E50',
        sage: '#9CAF88',
      }
    };
    
    const baseColor = materialColors[materialType]?.[materialOption] || '#C4B8A8';
    
    // Return the color for client-side fallback generation
    return res.json({
      success: true,
      tileUrl: null,
      fallbackColor: baseColor,
      materialType,
      materialOption,
      fallback: true,
      timestamp: new Date().toISOString(),
    });
    
  } catch (error) {
    console.error('[Material Tile] Error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to generate material tile' 
    });
  }
});

// ============================================================================
// UV Texture Editing Endpoint (LEGACY - kept for compatibility)
// This is the key endpoint for editing photogrammetry textures in UV space
// ============================================================================

router.post('/edit-uv-texture', async (req, res) => {
  try {
    const {
      textureImage,  // Base64 of the original UV texture atlas
      maskImage,     // Base64 of the UV mask (white = edit area)
      prompt,        // Detailed editing instructions
      renovationType,
      renovationOption,
      surfaceType,
    } = req.body;
    
    if (!textureImage || !maskImage) {
      return res.status(400).json({ 
        success: false, 
        error: 'Both textureImage and maskImage are required' 
      });
    }
    
    console.log('[UV Texture Edit] 🎨 Editing UV texture with Gemini...');
    console.log('[UV Texture Edit] Surface:', surfaceType, '- Type:', renovationType, '- Option:', renovationOption);
    
    // Extract base64 data
    const textureBase64 = textureImage.replace(/^data:image\/\w+;base64,/, '');
    const maskBase64 = maskImage.replace(/^data:image\/\w+;base64,/, '');
    
    // Build the prompt for UV-space texture editing
    const fullPrompt = prompt || `Edit this 3D texture atlas. The second image is a mask where WHITE areas show the ${surfaceType} that needs to be replaced with ${renovationOption} ${renovationType}.

CRITICAL INSTRUCTIONS:
- ONLY modify the white-masked areas
- Keep ALL other pixels EXACTLY the same
- Match the lighting and color temperature of the surrounding texture
- Make the new material look natural and photorealistic
- Blend seamlessly at mask edges
- This is a UV texture atlas - distortions are normal
- Preserve any shadows or objects overlapping the surface

Return the complete edited texture with the same dimensions.`;

    // Use Gemini 2.5 Flash Image (Nano Banana Pro) for best quality
    const modelName = 'gemini-2.5-flash-image';
    console.log('[UV Texture Edit] Using model:', modelName);
    
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      
      const result = await model.generateContent({
        contents: [{
          role: 'user',
          parts: [
            { text: fullPrompt },
            {
              inlineData: {
                mimeType: 'image/jpeg',
                data: textureBase64
              }
            },
            { text: 'Here is the mask image. WHITE areas should be edited:' },
            {
              inlineData: {
                mimeType: 'image/png',
                data: maskBase64
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
      
      let editedImage = null;
      let textResponse = '';
      
      for (const part of parts) {
        if (part.inlineData) {
          editedImage = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
          console.log('[UV Texture Edit] ✅ Got edited texture from Gemini!');
        }
        if (part.text) {
          textResponse = part.text;
        }
      }
      
      if (editedImage) {
        return res.json({
          success: true,
          editedTextureUrl: editedImage,
          description: textResponse,
          surfaceType,
          renovationType,
          renovationOption,
          timestamp: new Date().toISOString(),
        });
      }
      
      // No image returned, try fallback
      console.log('[UV Texture Edit] ⚠️ No image from Nano Banana, trying fallback...');
      
    } catch (nanoBananaError) {
      console.log('[UV Texture Edit] Nano Banana error:', nanoBananaError.message);
    }
    
    // Fallback to gemini-3-pro-image-preview (Nano Banana Pro)
    try {
      const fallbackModel = genAI.getGenerativeModel({ model: 'gemini-3-pro-image-preview' });
      
      const result = await fallbackModel.generateContent({
        contents: [{
          role: 'user',
          parts: [
            { text: fullPrompt },
            {
              inlineData: {
                mimeType: 'image/jpeg',
                data: textureBase64
              }
            },
            { text: 'Mask (edit white areas):' },
            {
              inlineData: {
                mimeType: 'image/png',
                data: maskBase64
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
      
      for (const part of parts) {
        if (part.inlineData) {
          const editedImage = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
          console.log('[UV Texture Edit] ✅ Got edited texture from fallback model!');
          
          return res.json({
            success: true,
            editedTextureUrl: editedImage,
            surfaceType,
            renovationType,
            renovationOption,
            timestamp: new Date().toISOString(),
          });
        }
      }
      
      // Still no image
      return res.json({
        success: false,
        error: 'UV texture editing not available - no image generated',
        suggestion: 'Try using the view-dependent projection method instead',
      });
      
    } catch (fallbackError) {
      console.error('[UV Texture Edit] Fallback also failed:', fallbackError.message);
      throw fallbackError;
    }
    
  } catch (error) {
    console.error('[UV Texture Edit] Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to edit UV texture',
      details: error.message,
    });
  }
});

// ============================================================================
// Get Material Library
// ============================================================================

router.get('/materials', (req, res) => {
  res.json({
    success: true,
    materials: {
      flooring: [
        { id: 'hardwood', name: 'Oak Hardwood', preview: '/materials/hardwood-oak.jpg', pricePerSqFt: 8 },
        { id: 'tile', name: 'Porcelain Tile', preview: '/materials/tile-porcelain.jpg', pricePerSqFt: 6 },
        { id: 'carpet', name: 'Plush Carpet', preview: '/materials/carpet-plush.jpg', pricePerSqFt: 4 },
        { id: 'vinyl', name: 'Luxury Vinyl', preview: '/materials/vinyl-luxury.jpg', pricePerSqFt: 5 },
        { id: 'marble', name: 'Marble Tile', preview: '/materials/marble.jpg', pricePerSqFt: 15 },
      ],
      paint: [
        { id: 'white', name: 'Bright White', hex: '#FFFFFF', pricePerSqFt: 0.5 },
        { id: 'gray', name: 'Light Gray', hex: '#D3D3D3', pricePerSqFt: 0.5 },
        { id: 'beige', name: 'Warm Beige', hex: '#F5DEB3', pricePerSqFt: 0.5 },
        { id: 'navy', name: 'Navy Blue', hex: '#000080', pricePerSqFt: 0.6 },
        { id: 'sage', name: 'Sage Green', hex: '#9CAF88', pricePerSqFt: 0.6 },
      ],
      countertop: [
        { id: 'granite', name: 'Black Granite', preview: '/materials/granite-black.jpg', pricePerSqFt: 60 },
        { id: 'quartz', name: 'White Quartz', preview: '/materials/quartz-white.jpg', pricePerSqFt: 75 },
        { id: 'marble', name: 'Carrara Marble', preview: '/materials/marble-carrara.jpg', pricePerSqFt: 100 },
        { id: 'butcher_block', name: 'Butcher Block', preview: '/materials/butcher-block.jpg', pricePerSqFt: 45 },
      ],
    }
  });
});

// ============================================================================
// Multi-View Renovation Retexturing Endpoints
// ============================================================================

/**
 * Edit a single view for retexturing.
 * This is called for each viewpoint rendered from the mesh.
 */
router.post('/edit-view-for-retexturing', async (req, res) => {
  try {
    const {
      imageDataUrl,
      prompt,
      renovationType,
      renovationOption,
      viewName,
    } = req.body;
    
    if (!imageDataUrl) {
      return res.status(400).json({ 
        success: false, 
        error: 'imageDataUrl is required' 
      });
    }
    
    console.log(`[Retexturing] 🎨 Editing view: ${viewName || 'unknown'}`);
    console.log(`[Retexturing] Renovation: ${renovationType} -> ${renovationOption}`);
    
    const imageBase64 = imageDataUrl.replace(/^data:image\/\w+;base64,/, '');
    
    // DEBUG: Save input image to /tmp for inspection
    const fs = await import('fs/promises');
    const debugDir = '/tmp/gemini-debug';
    await fs.mkdir(debugDir, { recursive: true });
    const debugPath = `${debugDir}/input_${viewName || 'unknown'}.png`;
    await fs.writeFile(debugPath, Buffer.from(imageBase64, 'base64'));
    console.log(`[Retexturing] DEBUG: Saved input to ${debugPath}`);
    
    // Use Gemini for image editing
    const modelName = 'gemini-2.5-flash-image';
    
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      
      const result = await model.generateContent({
        contents: [{
          role: 'user',
          parts: [
            { text: prompt },
            {
              inlineData: {
                mimeType: 'image/jpeg',
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
      
      let editedImage = null;
      
      for (const part of parts) {
        if (part.inlineData) {
          editedImage = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
          console.log(`[Retexturing] ✅ View edited: ${viewName}`);
        }
      }
      
      if (editedImage) {
        return res.json({
          success: true,
          editedImageUrl: editedImage,
          viewName,
          renovationType,
          renovationOption,
          timestamp: new Date().toISOString(),
        });
      }
      
      throw new Error('No edited image returned from Gemini');
      
    } catch (geminiError) {
      console.error('[Retexturing] Gemini error:', geminiError.message);
      
      // Check for rate limiting
      if (geminiError.message?.includes('429') || geminiError.message?.includes('quota') || geminiError.message?.includes('rate')) {
        return res.status(429).json({
          success: false,
          error: 'Rate limited - please retry',
          retryable: true,
        });
      }
      
      throw geminiError;
    }
    
  } catch (error) {
    console.error('[Retexturing] Error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to edit view' 
    });
  }
});

/**
 * Trigger OpenMVS retexturing on GCP.
 * Receives edited images + camera data, uploads to GCP, runs TextureMesh.
 */
router.post('/retexture-on-gcp', async (req, res) => {
  try {
    const {
      editedImages,  // Array of { name: string, dataUrl: string }
      cameraData,    // Array of camera intrinsics/extrinsics
      meshObjData,   // OBJ format string of the mesh
    } = req.body;
    
    console.log('[Retexturing] Received request with:', {
      editedImages: editedImages?.length || 0,
      cameraData: cameraData?.length || 0,
      meshObjDataLength: meshObjData?.length || 0,
    });
    
    if (!editedImages || !cameraData || !meshObjData) {
      console.log('[Retexturing] Missing required fields');
      return res.status(400).json({ 
        success: false, 
        error: 'editedImages, cameraData, and meshObjData are required' 
      });
    }
    
    console.log(`[Retexturing] 🚀 Starting GCP retexturing with ${editedImages.length} views`);
    
    // Import GCP GPU Worker
    let gcpWorker;
    try {
      const { getGcpGpuWorker } = await import('../services/gcpGpuWorker.js');
      gcpWorker = getGcpGpuWorker();
    } catch (e) {
      console.warn('[Retexturing] GCP Worker not available:', e.message);
      return res.status(503).json({
        success: false,
        error: 'GCP GPU Worker not available. Check GCP_GPU_WORKER_ENABLE environment variable.',
      });
    }
    
    if (!gcpWorker.enabled) {
      return res.status(503).json({
        success: false,
        error: 'GCP GPU Worker is not enabled. Set GCP_GPU_WORKER_ENABLE=true in .env',
      });
    }
    
    // Check if GCP is available
    const isAvailable = await gcpWorker.isAvailable();
    if (!isAvailable) {
      console.log('[Retexturing] Starting GCP VM...');
      await gcpWorker.startVM();
    }
    
    // Create temp directory for images
    const fs = await import('fs/promises');
    const path = await import('path');
    const os = await import('os');
    
    const tempDir = path.join(os.tmpdir(), `retexture-${Date.now()}`);
    const imagesDir = path.join(tempDir, 'images');
    await fs.mkdir(imagesDir, { recursive: true });
    
    // Save edited images to temp directory and detect actual dimensions
    console.log('[Retexturing] Saving edited images...');
    let actualImageWidth = null;
    let actualImageHeight = null;
    
    // Import sharp for image dimension detection
    let sharp;
    try {
      sharp = (await import('sharp')).default;
    } catch (e) {
      console.warn('[Retexturing] Sharp not available, will use intrinsic dimensions');
    }
    
    for (const img of editedImages) {
      const base64Data = img.dataUrl.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');
      const imgPath = path.join(imagesDir, img.name);
      await fs.writeFile(imgPath, buffer);
      
      // Detect actual image dimensions from first image
      if (actualImageWidth === null && sharp) {
        try {
          const metadata = await sharp(buffer).metadata();
          actualImageWidth = metadata.width;
          actualImageHeight = metadata.height;
          console.log(`[Retexturing] Detected actual image dimensions: ${actualImageWidth}x${actualImageHeight}`);
        } catch (e) {
          console.warn('[Retexturing] Could not detect image dimensions:', e.message);
        }
      }
    }
    
    // Adjust camera intrinsics if actual dimensions differ from expected
    let adjustedCameraData = cameraData;
    if (actualImageWidth && actualImageHeight) {
      const expectedWidth = cameraData[0].intrinsics.width;
      const expectedHeight = cameraData[0].intrinsics.height;
      
      if (actualImageWidth !== expectedWidth || actualImageHeight !== expectedHeight) {
        console.log(`[Retexturing] ⚠️ Image dimension mismatch!`);
        console.log(`[Retexturing]   Expected: ${expectedWidth}x${expectedHeight}`);
        console.log(`[Retexturing]   Actual: ${actualImageWidth}x${actualImageHeight}`);
        console.log(`[Retexturing]   Scaling camera intrinsics to match...`);
        
        const scaleX = actualImageWidth / expectedWidth;
        const scaleY = actualImageHeight / expectedHeight;
        
        adjustedCameraData = cameraData.map(cam => ({
          ...cam,
          intrinsics: {
            width: actualImageWidth,
            height: actualImageHeight,
            fx: cam.intrinsics.fx * scaleX,
            fy: cam.intrinsics.fy * scaleY,
            cx: cam.intrinsics.cx * scaleX,
            cy: cam.intrinsics.cy * scaleY,
          }
        }));
        
        console.log(`[Retexturing] ✅ Adjusted intrinsics:`, adjustedCameraData[0].intrinsics);
      }
    }
    
    // Compute mesh bounding box from OBJ data to center it at origin
    console.log('[Retexturing] Computing mesh bounding box...');
    const meshBounds = computeMeshBounds(meshObjData);
    console.log('[Retexturing] Mesh bounds:', {
      min: meshBounds.min,
      max: meshBounds.max,
      center: meshBounds.center,
      size: meshBounds.size
    });
    
    // Center the mesh at the origin to match camera coordinate system
    // The client-side cameras are in a centered coordinate system (around origin)
    // so we need to transform the mesh vertices to match
    const meshCenterOffset = meshBounds.center;
    console.log(`[Retexturing] Centering mesh by offset: (${-meshCenterOffset.x.toFixed(2)}, ${-meshCenterOffset.y.toFixed(2)}, ${-meshCenterOffset.z.toFixed(2)})`);
    
    const centeredMeshData = meshObjData.replace(/^v ([-\d.]+) ([-\d.]+) ([-\d.]+)/gm, (match, x, y, z) => {
      const centeredX = parseFloat(x) - meshCenterOffset.x;
      const centeredY = parseFloat(y) - meshCenterOffset.y;
      const centeredZ = parseFloat(z) - meshCenterOffset.z;
      return `v ${centeredX} ${centeredY} ${centeredZ}`;
    });
    
    console.log('[Retexturing] Sample vertex before centering:', meshObjData.match(/^v .+/m)?.[0]);
    console.log('[Retexturing] Sample vertex after centering:', centeredMeshData.match(/^v .+/m)?.[0]);
    
    // Save centered mesh OBJ to file
    console.log('[Retexturing] Saving centered mesh OBJ...');
    const meshPath = path.join(tempDir, 'input_mesh.obj');
    await fs.writeFile(meshPath, centeredMeshData, 'utf8');
    
    // Save camera data in COLMAP format (no adjustment needed now)
    console.log('[Retexturing] Saving camera data...');
    await writeCameraDataColmap(tempDir, adjustedCameraData);
    
    // Upload to GCP and run retexturing
    const result = await gcpWorker.runRetexturing(tempDir, meshPath);
    
    // Cleanup temp directory
    await fs.rm(tempDir, { recursive: true, force: true });
    
    console.log('[Retexturing] ✅ GCP retexturing complete');
    
    return res.json({
      success: true,
      texturedMeshUrl: result.texturedMeshUrl,
      textureUrl: result.textureUrl,
      processingTimeMs: result.processingTimeMs,
    });
    
  } catch (error) {
    console.error('[Retexturing] GCP error:', error);
    console.error('[Retexturing] Error stack:', error.stack);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to retexture on GCP' 
    });
  }
});

/**
 * Compute bounding box from OBJ file data
 */
function computeMeshBounds(objData) {
  const lines = objData.split('\n');
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  
  for (const line of lines) {
    if (line.startsWith('v ')) {
      const parts = line.split(/\s+/);
      const x = parseFloat(parts[1]);
      const y = parseFloat(parts[2]);
      const z = parseFloat(parts[3]);
      
      if (!isNaN(x) && !isNaN(y) && !isNaN(z)) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        minZ = Math.min(minZ, z);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        maxZ = Math.max(maxZ, z);
      }
    }
  }
  
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const centerZ = (minZ + maxZ) / 2;
  
  return {
    min: { x: minX, y: minY, z: minZ },
    max: { x: maxX, y: maxY, z: maxZ },
    center: { x: centerX, y: centerY, z: centerZ },
    size: { x: maxX - minX, y: maxY - minY, z: maxZ - minZ }
  };
}

/**
 * Write camera data in COLMAP format for OpenMVS
 */
async function writeCameraDataColmap(outputDir, cameraData) {
  const fs = await import('fs/promises');
  const path = await import('path');
  
  // OpenMVS InterfaceCOLMAP expects files in 'sparse/' directly (not 'sparse/0/')
  const sparseDir = path.join(outputDir, 'sparse');
  await fs.mkdir(sparseDir, { recursive: true });
  
  // Write cameras.txt
  let camerasContent = '# Camera list with one line of data per camera:\n';
  camerasContent += '#   CAMERA_ID, MODEL, WIDTH, HEIGHT, PARAMS[]\n';
  camerasContent += '# Number of cameras: 1\n';
  
  const sample = cameraData[0];
  const { width, height, fx, fy, cx, cy } = sample.intrinsics;
  camerasContent += `1 PINHOLE ${width} ${height} ${fx} ${fy} ${cx} ${cy}\n`;
  
  await fs.writeFile(path.join(sparseDir, 'cameras.txt'), camerasContent);
  
  // Write images.txt
  let imagesContent = '# Image list with two lines of data per image:\n';
  imagesContent += '#   IMAGE_ID, QW, QX, QY, QZ, TX, TY, TZ, CAMERA_ID, NAME\n';
  imagesContent += '#   POINTS2D[] as (X, Y, POINT3D_ID)\n';
  
  for (let i = 0; i < cameraData.length; i++) {
    const cam = cameraData[i];
    const { qw, qx, qy, qz, tx, ty, tz } = cam.extrinsics;
    imagesContent += `${i + 1} ${qw} ${qx} ${qy} ${qz} ${tx} ${ty} ${tz} 1 ${cam.imageName}\n`;
    imagesContent += '\n';  // Empty line for points2D
  }
  
  await fs.writeFile(path.join(sparseDir, 'images.txt'), imagesContent);
  
  // Write points3D.txt (empty - we don't need points for retexturing)
  await fs.writeFile(path.join(sparseDir, 'points3D.txt'), '# 3D point list (empty for retexturing)\n');
  
  console.log('[Retexturing] Camera data saved in COLMAP format');
}
// ============================================================================
// Generate Renovation Suggestion Preview
// Uses Nano Banana Pro (Gemini 2.5 Flash Image) to show what a suggested
// renovation will look like using the REAL products/materials found from
// live product search results
// ============================================================================

router.post('/generate-suggestion-preview', async (req, res) => {
  try {
    const {
      images,                // Array of base64 images (all uploaded property photos)
      imageData,             // Legacy single image fallback
      suggestion,            // Full renovation suggestion object
      shoppableProducts,     // Products found from live search (with titles, prices, images)
      propertyAddress,       // Property address for context
      selectedMaterial,      // User-selected material from the available products (object with title, price, retailer, etc.)
      customMaterialDescription, // User-typed custom material description (free text)
    } = req.body;

    // Support both multi-image (images[]) and legacy single image (imageData)
    const allImages = images && Array.isArray(images) && images.length > 0
      ? images
      : imageData ? [imageData] : [];

    if (allImages.length === 0) {
      return res.status(400).json({ success: false, error: 'At least one image is required' });
    }
    if (!suggestion) {
      return res.status(400).json({ success: false, error: 'Renovation suggestion data required' });
    }

    console.log('[Renovation Preview] 🎨 Generating suggestion previews for', allImages.length, 'images...');
    console.log('[Renovation Preview] Suggestion:', suggestion.name);

    const canonicalResult = suggestion.canonicalResult || null;
    const canonicalContext = suggestion.canonicalContext || null;
    const canonicalScopeLabel = canonicalResult?.canonicalRoomType
      || canonicalResult?.canonicalCategory
      || canonicalResult?.canonicalScopeType
      || canonicalContext?.canonicalRoomType
      || canonicalContext?.canonicalCategory
      || canonicalContext?.canonicalScopeType
      || null;

    // =========================================================================
    // Determine THE ONE material to use — consistency across all images
    // Priority: 1) User custom description, 2) User-selected product, 3) Best value auto-pick
    // =========================================================================
    let chosenMaterial = null;
    let materialDetails = '';

    if (customMaterialDescription && customMaterialDescription.trim()) {
      // User typed a custom material description
      chosenMaterial = { title: customMaterialDescription.trim(), source: 'custom', price: null, retailer: null };
      materialDetails = `

═══════════════════════════════════════════════════════════════
USER-SPECIFIED MATERIAL — USE THIS EXACT MATERIAL
═══════════════════════════════════════════════════════════════
The user has specifically requested this material:
"${customMaterialDescription.trim()}"

You MUST use this exact material description to determine the appearance.
Match the color, texture, grain, pattern, finish, and style described.
Apply this SAME material identically across ALL images.
═══════════════════════════════════════════════════════════════`;

    } else if (selectedMaterial && selectedMaterial.title) {
      // User selected a specific product from the found options
      chosenMaterial = selectedMaterial;
      materialDetails = `

═══════════════════════════════════════════════════════════════
SELECTED PRODUCT — USE THIS EXACT PRODUCT'S APPEARANCE
═══════════════════════════════════════════════════════════════
★ PRODUCT: "${selectedMaterial.title}"
  PRICE: $${selectedMaterial.price || 'N/A'}
  RETAILER: ${selectedMaterial.retailer || 'N/A'}
  ${selectedMaterial.snippet ? `VISUAL DETAILS: ${selectedMaterial.snippet.substring(0, 300)}` : ''}

→ You MUST match this product's EXACT color, texture, grain pattern, finish, and sheen.
→ Apply this IDENTICAL material across ALL images — no variation allowed.
→ Every angle must show the same flooring/material with the same color tone.
═══════════════════════════════════════════════════════════════`;

    } else if (shoppableProducts?.recommendations) {
      // Auto-pick: find the single BEST VALUE product (most timeless + cost effective)
      const allProducts = [];
      for (const [category, data] of Object.entries(shoppableProducts.recommendations)) {
        const catData = data;
        if (catData.products && Array.isArray(catData.products)) {
          for (const product of catData.products) {
            allProducts.push({ ...product, category });
          }
        }
      }

      if (allProducts.length > 0) {
        // Pick the best value: prefer mid-range priced products with good descriptions
        // Sort by: has price, mid-range price, has description
        const scored = allProducts.map(p => {
          let score = 0;
          if (p.price && p.price > 0) score += 10;
          if (p.snippet && p.snippet.length > 30) score += 5;
          if (p.retailer?.name) score += 3;
          // Prefer mid-range (not cheapest, not most expensive)
          if (p.price >= 2 && p.price <= 8) score += 8; // sweet spot for per-sqft flooring
          if (p.price >= 1 && p.price <= 15) score += 4;
          return { ...p, score };
        }).sort((a, b) => b.score - a.score);

        chosenMaterial = scored[0];
        console.log(`[Renovation Preview] Auto-selected material: "${chosenMaterial.title}" ($${chosenMaterial.price})`);

        materialDetails = `

═══════════════════════════════════════════════════════════════
SELECTED MATERIAL — USE THIS EXACT PRODUCT (AUTO-PICKED BEST VALUE)
═══════════════════════════════════════════════════════════════
★ PRODUCT: "${chosenMaterial.title}"
  PRICE: $${chosenMaterial.price || 'N/A'}
  RETAILER: ${chosenMaterial.retailer?.name || chosenMaterial.retailer || 'N/A'}
  ${chosenMaterial.snippet ? `VISUAL DETAILS: ${chosenMaterial.snippet.substring(0, 300)}` : ''}

CRITICAL: Use ONLY this ONE product's appearance for ALL images.
→ Match this product's EXACT color, texture, grain pattern, finish, and sheen.
→ Do NOT mix materials. Do NOT use a different product for different angles.
→ Every single image must show the EXACT SAME material — identical tone, identical pattern.
═══════════════════════════════════════════════════════════════`;
      }
    }

    // Build material details from materialBreakdown if no shoppable products
    let materialBreakdownText = '';
    if (suggestion.materialBreakdown && suggestion.materialBreakdown.length > 0) {
      materialBreakdownText = '\n\nMATERIALS SPECIFIED IN RENOVATION SCOPE:\n';
      for (const mat of suggestion.materialBreakdown) {
        materialBreakdownText += `  • ${mat.item}: ${mat.quantity} ${mat.unit}`;
        if (mat.unitCost) materialBreakdownText += ` @ $${mat.unitCost}/${mat.unit}`;
        materialBreakdownText += '\n';
      }
    }

    // Determine exactly WHAT should change based on renovation type
    const renovationTarget = (
      canonicalScopeLabel
      || suggestion.type
      || suggestion.name
      || ''
    ).toLowerCase();
    let whatToChange = '';
    let whatToNeverChange = '';

    if (renovationTarget.includes('floor') || renovationTarget.includes('carpet') || renovationTarget.includes('hardwood') || renovationTarget.includes('lvp') || renovationTarget.includes('tile')) {
      whatToChange = 'ONLY the floor surface/flooring material';
      whatToNeverChange = 'walls, ceiling, furniture, decor, lighting, doors, windows, baseboards (unless the renovation explicitly includes them), rugs, personal items, bed, desk, chairs, shelves, wall art, posters, curtains, blinds, electronics, all objects on surfaces';
    } else if (renovationTarget.includes('paint') || renovationTarget.includes('wall')) {
      whatToChange = 'ONLY the wall paint color/finish';
      whatToNeverChange = 'flooring, ceiling, furniture, decor, lighting, doors, windows, trim/molding, wall art placement, shelves, curtains, blinds, all furniture and personal items';
    } else if (renovationTarget.includes('kitchen') || renovationTarget.includes('cabinet') || renovationTarget.includes('countertop') || renovationTarget.includes('backsplash')) {
      whatToChange = 'ONLY the specific kitchen elements mentioned (cabinets, countertops, backsplash, appliances — whichever the renovation specifies)';
      whatToNeverChange = 'room layout, kitchen footprint, window positions, floor (unless specified), ceiling, items on counters, wall decor, lighting fixture positions';
    } else if (renovationTarget.includes('bath') || renovationTarget.includes('vanity') || renovationTarget.includes('shower') || renovationTarget.includes('toilet')) {
      whatToChange = 'ONLY the specific bathroom elements mentioned (vanity, toilet, shower, tile — whichever the renovation specifies)';
      whatToNeverChange = 'room layout, plumbing positions, window positions, towels, toiletries, decor items, mirror position (unless specified)';
    } else if (renovationTarget.includes('light') || renovationTarget.includes('fixture')) {
      whatToChange = 'ONLY the light fixtures/lighting elements';
      whatToNeverChange = 'walls, floors, ceiling color, furniture, decor, all other fixtures, personal items, everything else in the room';
    } else if (renovationTarget.includes('appliance')) {
      whatToChange = 'ONLY the appliances being replaced';
      whatToNeverChange = 'cabinets, countertops, floors, walls, ceiling, layout, all non-appliance items';
    } else {
      whatToChange = `ONLY the elements specifically described in the renovation: "${suggestion.name}"`;
      whatToNeverChange = 'everything else not explicitly mentioned in the renovation scope';
    }

    // =========================================================================
    // Build the STRICT editing prompt
    // =========================================================================
    const canonicalPromptContext = canonicalResult || canonicalContext
      ? `
  CANONICAL RESULT ID: ${canonicalResult?.resultId || 'unavailable'}
  CANONICAL PRIMARY KEY: ${canonicalResult?.primaryKey || canonicalContext?.primaryKey || 'unavailable'}
  CANONICAL OPPORTUNITY ID: ${canonicalResult?.canonicalOpportunityId || canonicalContext?.canonicalOpportunityId || 'unavailable'}
  CANONICAL SCOPE LABEL: ${canonicalScopeLabel || 'unavailable'}
  MEASURED SCOPE: ${(canonicalResult?.measurementMatched ?? canonicalContext?.measurementMatched) ? 'yes' : 'no'}
  TRIGGER FINDINGS: ${canonicalResult?.triggerFindingCount ?? canonicalContext?.triggerFindingCount ?? 0}`
      : '';

    const fullPrompt = `You are performing a SURGICAL image edit on a real property photo. You are showing what one specific renovation will look like when complete.

════════════════════════════════════════════════════════
RENOVATION: ${suggestion.name}
TYPE: ${suggestion.type || 'general'}
DESCRIPTION: ${suggestion.summary || ''}
${suggestion.details ? `SCOPE: ${suggestion.details.substring(0, 600)}` : ''}
  ${canonicalPromptContext}
════════════════════════════════════════════════════════
${materialDetails}${materialBreakdownText}
════════════════════════════════════════════════════════
WHAT TO CHANGE: ${whatToChange}
════════════════════════════════════════════════════════
DO NOT CHANGE (leave pixel-perfect identical): ${whatToNeverChange}
════════════════════════════════════════════════════════

ABSOLUTE RULES — VIOLATIONS WILL MAKE THE RESULT USELESS:

1. CAMERA: The output image MUST have the IDENTICAL camera angle, lens distortion, perspective, and framing as the input. Do NOT shift, crop, rotate, zoom, or alter the viewpoint in ANY way.

2. GEOMETRY: Every wall, corner, doorway, window, ceiling line, and architectural element MUST remain in the EXACT same pixel position. Do NOT move, reshape, add, or remove any structural element.

3. OBJECTS: Every piece of furniture, every personal item, every decoration, every poster, every book, every electronic device, every plant — EVERYTHING that is not part of the renovation — MUST remain EXACTLY where it is, at the EXACT same size, angle, and appearance. Do NOT remove, reposition, resize, restyle, or alter ANY object.

4. LIGHTING: Keep the SAME lighting conditions, shadows, and ambient light. Only adjust reflections/highlights on the NEW material surfaces to be physically accurate for that material.

5. THE EDIT: Apply ONLY the renovation described above. The new material/product must look:
   - Professionally installed (no visible seams unless realistic, proper alignment)
   - Physically accurate (correct scale relative to room, realistic texture resolution)
   - Matching the EXACT appearance of the real products listed above (color, grain, pattern, finish, sheen)
   - Properly lit to match the existing room lighting

6. BOUNDARIES: The renovation edit should have clean, precise edges where the new material meets unchanged surfaces (e.g., flooring meets walls at the baseboard line, paint stops at trim edges).

7. FIDELITY: The output should be INDISTINGUISHABLE from a real photograph. A real estate photographer should not be able to tell this was AI-edited.

8. CROSS-IMAGE CONSISTENCY: You are editing multiple photos of the SAME room from different angles. The material you apply MUST be IDENTICAL across every single image — same exact color tone, same grain/pattern direction, same finish/sheen level. A viewer flipping between angles must see the EXACT SAME material in every photo.

9. SINGLE MATERIAL ONLY: Use ONLY the ONE material specified above. Do NOT introduce alternative materials, do NOT mix flooring types, do NOT vary the color between images. ONE material, applied uniformly.

REMEMBER: If something is NOT part of "${suggestion.name}", do NOT touch it. The ONLY difference between input and output should be the renovation itself.`;

    // =========================================================================
    // Generate preview for EACH image (multi-angle)
    // =========================================================================
    const previews = [];
    const maxImages = Math.min(allImages.length, 4); // Cap at 4 to avoid timeout

    for (let i = 0; i < maxImages; i++) {
      const imgData = allImages[i];
      const base64Data = imgData.replace(/^data:image\/\w+;base64,/, '');
      
      console.log(`[Renovation Preview] Processing image ${i + 1}/${maxImages}...`);

      let generatedImage = null;
      let textResponse = '';

      // Helper to try a model
      const tryModel = async (modelName) => {
        const model = genAI.getGenerativeModel({ model: modelName });
        const result = await model.generateContent({
          contents: [{
            role: 'user',
            parts: [
              { text: fullPrompt },
              {
                inlineData: {
                  mimeType: 'image/jpeg',
                  data: base64Data
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
        let img = null;
        let txt = '';

        for (const part of parts) {
          if (part.inlineData) {
            img = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
          }
          if (part.text) {
            txt = part.text;
          }
        }
        return { img, txt };
      };

      // Try models in order
      const modelAttempts = [
        'gemini-2.5-flash-image',
        'gemini-3-pro-image-preview'
      ];

      for (const modelName of modelAttempts) {
        if (generatedImage) break;
        try {
          console.log(`[Renovation Preview] Image ${i + 1} — trying ${modelName}...`);
          const { img, txt } = await tryModel(modelName);
          if (img) {
            generatedImage = img;
            textResponse = txt;
            console.log(`[Renovation Preview] ✅ Image ${i + 1} generated with ${modelName}`);
          }
        } catch (err) {
          console.log(`[Renovation Preview] ${modelName} failed for image ${i + 1}:`, err.message);
        }
      }

      previews.push({
        index: i,
        success: !!generatedImage,
        previewImageUrl: generatedImage || null,
        description: textResponse || null,
        originalImageIndex: i,
      });
    }

    const successCount = previews.filter(p => p.success).length;

    if (successCount > 0) {
      console.log(`[Renovation Preview] ✅ Generated ${successCount}/${maxImages} previews successfully`);
      return res.json({
        success: true,
        previews,
        // Legacy compat: first successful preview
        previewImageUrl: previews.find(p => p.success)?.previewImageUrl,
        description: previews.find(p => p.success)?.description,
        renovationName: suggestion.name,
        renovationType: suggestion.type,
        totalImages: maxImages,
        successCount,
        productsUsed: shoppableProducts?.recommendations
          ? Object.entries(shoppableProducts.recommendations).flatMap(([cat, data]) =>
              (data.products || []).slice(0, 2).map(p => ({
                category: cat,
                title: p.title,
                price: p.price,
                retailer: p.retailer?.name,
                url: p.url,
                image: p.image
              }))
            )
          : [],
        chosenMaterial: chosenMaterial ? {
          title: chosenMaterial.title,
          price: chosenMaterial.price,
          retailer: chosenMaterial.retailer?.name || chosenMaterial.retailer || null,
          image: chosenMaterial.image || null,
          url: chosenMaterial.url || null,
          snippet: chosenMaterial.snippet || null,
          source: chosenMaterial.source || 'auto',
        } : null,
        availableProducts: shoppableProducts?.recommendations
          ? Object.entries(shoppableProducts.recommendations).flatMap(([cat, data]) =>
              (data.products || []).map(p => ({
                category: cat,
                title: p.title,
                price: p.price,
                retailer: p.retailer?.name || null,
                url: p.url,
                image: p.image,
                snippet: p.snippet || null,
              }))
            )
          : [],
        timestamp: new Date().toISOString(),
      });
    }

    // No images generated from any model
    return res.json({
      success: false,
      error: 'Unable to generate preview images — AI models did not return any images',
      description: previews[0]?.description || `Preview for: ${suggestion.name}`,
    });

  } catch (error) {
    console.error('[Renovation Preview] Suggestion preview error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate renovation suggestion preview',
      details: error.message
    });
  }
});

router.post('/save-preview', requireAuth, async (req, res) => {
  try {
    const {
      userId,
      propertyId,
      propertyAddress,
      suggestion,
      previewResult,
      originalImageUrls = [],
    } = req.body || {};

    if (!userId || !propertyId || !suggestion?.id || !previewResult) {
      return res.status(400).json({ ok: false, error: 'missing_preview_persistence_fields' });
    }

    if (!ensurePreviewUserAccess(req, res, userId)) {
      return;
    }

    const db = getPreviewDb();
    const { previewImages, originalImages, canonicalMetadata } = await uploadSuggestionPreviewImages({
      userId,
      propertyId,
      suggestion,
      previewResult,
      originalImageUrls,
    });

    const firestoreData = {
      userId,
      propertyId,
      propertyAddress: propertyAddress || '',
      renovationId: suggestion.id,
      renovationName: suggestion.name || '',
      renovationType: suggestion.type || 'general',
      renovationSummary: suggestion.summary || '',
      ...canonicalMetadata,
      chosenMaterial: previewResult.chosenMaterial || null,
      productsUsed: previewResult.productsUsed || [],
      availableProducts: previewResult.availableProducts || [],
      previewImages,
      originalImages,
      totalAngles: previewResult.totalImages || previewImages.length,
      successCount: previewResult.successCount || previewImages.length,
      description: previewResult.description || '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const docRef = await db.collection(PREVIEW_COLLECTION).add(firestoreData);
    console.log(`[Renovation Preview] ✅ Saved preview ${docRef.id} via backend Firebase Admin`);

    res.json({
      ok: true,
      firestoreDocId: docRef.id,
      storageUrls: previewImages,
    });
  } catch (error) {
    console.error('[Renovation Preview] Failed to save preview via backend:', error);
    res.status(500).json({
      ok: false,
      error: error.message || 'failed_to_save_preview',
    });
  }
});

router.get('/saved-previews', requireAuth, async (req, res) => {
  try {
    const userId = String(req.query.userId || '').trim();
    const propertyId = String(req.query.propertyId || '').trim();

    if (!userId || !propertyId) {
      return res.status(400).json({ ok: false, error: 'missing_user_or_property' });
    }

    if (!ensurePreviewUserAccess(req, res, userId)) {
      return;
    }

    const db = getPreviewDb();
    const snapshot = await db.collection(PREVIEW_COLLECTION)
      .where('userId', '==', userId)
      .where('propertyId', '==', propertyId)
      .get();

    const previews = sortPreviewsDescendingByCreatedAt(
      snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
    );

    res.json({ ok: true, previews });
  } catch (error) {
    console.error('[Renovation Preview] Failed to load saved previews via backend:', error);
    res.status(500).json({
      ok: false,
      error: error.message || 'failed_to_load_saved_previews',
    });
  }
});

router.post('/update-saved-preview-material', requireAuth, async (req, res) => {
  try {
    const {
      firestoreDocId,
      newPreviewResult,
      userId,
      propertyId,
      suggestionId,
      suggestion,
    } = req.body || {};

    if (!firestoreDocId || !newPreviewResult || !userId || !propertyId || !suggestionId) {
      return res.status(400).json({ ok: false, error: 'missing_preview_update_fields' });
    }

    if (!ensurePreviewUserAccess(req, res, userId)) {
      return;
    }

    const db = getPreviewDb();
    const { previewImages, canonicalMetadata } = await uploadSuggestionPreviewImages({
      userId,
      propertyId,
      suggestion: {
        id: suggestionId,
        ...(suggestion || {}),
      },
      previewResult: newPreviewResult,
      originalImageUrls: [],
    });

    await db.collection(PREVIEW_COLLECTION).doc(firestoreDocId).set({
      previewImages,
      ...canonicalMetadata,
      chosenMaterial: newPreviewResult.chosenMaterial || null,
      productsUsed: newPreviewResult.productsUsed || [],
      availableProducts: newPreviewResult.availableProducts || [],
      successCount: newPreviewResult.successCount || previewImages.length,
      description: newPreviewResult.description || '',
      updatedAt: new Date().toISOString(),
    }, { merge: true });

    console.log(`[Renovation Preview] ✅ Updated preview ${firestoreDocId} via backend Firebase Admin`);
    res.json({ ok: true, firestoreDocId, storageUrls: previewImages });
  } catch (error) {
    console.error('[Renovation Preview] Failed to update saved preview via backend:', error);
    res.status(500).json({
      ok: false,
      error: error.message || 'failed_to_update_saved_preview',
    });
  }
});

export default router;
