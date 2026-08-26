/**
 * Calibration API Routes
 * Handles AI-powered object detection and product spec lookups for mesh calibration
 */

import express from 'express';
import OpenAI from 'openai';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Google Custom Search API
const GOOGLE_API_KEY = process.env.GOOGLE_SEARCH_API_KEY;
const GOOGLE_CX = process.env.GOOGLE_SEARCH_ENGINE_ID || process.env.GOOGLE_CX;

// ============================================================================
// Helper: Get original scan images (much better for AI than 3D render)
// ============================================================================

async function getOriginalScanImages(scanId, maxImages = 4) {
  const photogrammetryDir = path.join(__dirname, 'data', 'photogrammetry', scanId);
  const roomScanDir = path.join(__dirname, 'data', 'room-scans', scanId);
  
  let imagesDir = null;
  
  // Check different possible locations
  const possiblePaths = [
    path.join(photogrammetryDir, 'raw', 'images'),
    path.join(photogrammetryDir, 'images'),
    path.join(photogrammetryDir, 'photos'),
    path.join(roomScanDir, 'images'),
    path.join(roomScanDir, 'photos'),
  ];
  
  for (const dirPath of possiblePaths) {
    try {
      await fs.access(dirPath);
      imagesDir = dirPath;
      console.log('[Calibration] Found images at:', dirPath);
      break;
    } catch {
      // Try next path
    }
  }
  
  if (!imagesDir) {
    console.log('[Calibration] No original images found for scan:', scanId);
    return [];
  }
  
  // Read image files
  const files = await fs.readdir(imagesDir);
  const imageFiles = files.filter(f => 
    /\.(jpg|jpeg|png|webp)$/i.test(f)
  ).slice(0, maxImages);
  
  console.log('[Calibration] Found', imageFiles.length, 'images');
  
  // Convert to base64
  const images = await Promise.all(
    imageFiles.map(async (filename) => {
      const filepath = path.join(imagesDir, filename);
      const buffer = await fs.readFile(filepath);
      const base64 = buffer.toString('base64');
      const ext = path.extname(filename).toLowerCase().replace('.', '');
      const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';
      return {
        data: `data:${mimeType};base64,${base64}`,
        filename
      };
    })
  );
  
  return images;
}

// ============================================================================
// Standard Dimensions Reference
// ============================================================================

const STANDARD_DIMENSIONS = {
  // Electrical - NEMA standard
  outlet_cover: { height: 4.5, width: 2.75 },
  switch_plate: { height: 4.5, width: 2.75 },
  decora_plate: { height: 4.5, width: 2.75 },
  
  // Bathroom
  bathtub_standard: { length: 60, width: 30 },
  toilet_width: 14.5,
  toilet_seat_height: 15,
  comfort_height_toilet: 17,
  
  // Kitchen
  counter_height: 36,
  dishwasher_width: 24,
  oven_width: 30,
  refrigerator_width_standard: 36,
  
  // Doors
  interior_door_height: 80,
  door_handle_height: 36,
  door_frame_width: 4.5,
  
  // Flooring
  tile_12: 12,
  tile_18: 18,
  tile_24: 24,
  baseboard_standard: 3.5,
  baseboard_tall: 5.25,
  
  // Ceiling
  ceiling_8ft: 96,
  ceiling_9ft: 108,
};

// ============================================================================
// Object Detection Endpoint
// ============================================================================

router.post('/detect-objects', async (req, res) => {
  try {
    const { imageData, image, scanId, useOriginalImages = true } = req.body;
    const fallbackImage = imageData || image;
    
    console.log('[Calibration] 🔍 Starting object detection for scan:', scanId);
    console.log('[Calibration] Use original images:', useOriginalImages);
    
    // Try to get original scan images first (much better quality)
    let imagesToAnalyze = [];
    
    if (useOriginalImages && scanId) {
      console.log('[Calibration] 📷 Attempting to load original scan photos...');
      const originalImages = await getOriginalScanImages(scanId, 3);
      
      if (originalImages.length > 0) {
        imagesToAnalyze = originalImages.map(img => img.data);
        console.log('[Calibration] ✅ Using', originalImages.length, 'original scan photos');
        console.log('[Calibration] Photo files:', originalImages.map(i => i.filename).join(', '));
      } else {
        console.log('[Calibration] ⚠️  No original images found, falling back to 3D render screenshot');
      }
    }
    
    // Fall back to the 3D render screenshot if no original images
    let usedOriginalImages = imagesToAnalyze.length > 0;
    
    if (imagesToAnalyze.length === 0) {
      if (!fallbackImage) {
        return res.status(400).json({ 
          success: false,
          error: 'No images available. Scan may not have original photos stored.',
          detectedObjects: [],
          usedOriginalImages: false
        });
      }
      imagesToAnalyze = [fallbackImage];
      usedOriginalImages = false;
      console.log('[Calibration] Using 3D render screenshot (lower quality)');
    }
    
    // Build the image content for OpenAI
    const imageContent = imagesToAnalyze.map(imgData => ({
      type: 'image_url',
      image_url: { url: imgData }
    }));
    
    console.log('[Calibration] 🤖 Sending', imagesToAnalyze.length, 'image(s) to GPT-4o Vision...');
    
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Analyze this room scan image to find objects with KNOWN EXACT DIMENSIONS for calibration.

DETECTION PRIORITY (return in this order):

## TIER 0: BRANDED PRODUCTS (HIGHEST PRIORITY)
Look for ANY recognizable branded items with visible logos/labels:
- Appliances: Samsung, LG, GE, Whirlpool, KitchenAid, Bosch dishwashers/ovens/fridges
- Electronics: TV brands (Samsung, LG, Sony), monitors, laptops
- Furniture: IKEA products (often have visible labels)
- Water bottles: Yeti, Hydro Flask, Nalgene (known sizes)
- Books: recognize specific titles if visible
- Any product where brand + model is identifiable

For branded items, I will search for exact manufacturer specifications.

## TIER 1: ELECTRICAL (NEMA STANDARD - Very Reliable)
- Outlet cover: EXACTLY 4.500" × 2.750"
- Light switch plate: EXACTLY 4.500" × 2.750"
- Decora/rocker plate: EXACTLY 4.500" × 2.750"

## TIER 2: BATHROOM FIXTURES
- Standard bathtub: 60.0" long × 30.0" wide
- Toilet width: 14.5" at widest
- Toilet seat height: 15.0" (standard) or 17.0" (comfort height)

## TIER 3: KITCHEN FIXTURES
- Counter height from floor: 36.0"
- Standard dishwasher: 24.0" wide
- Standard oven: 30.0" wide

## TIER 4: DOORS
- Interior door height: 80.0" (6'8")
- Door handle height from floor: 36.0"
- Door frame/casing width: 4.5"

## TIER 5: FLOORING/TRIM
- Common tile sizes: 12"×12", 18"×18", 24"×24"
- Standard baseboard: 3.5" or 5.25" tall

Return JSON:
{
  "objects": [
    {
      "id": "obj_1",
      "type": "branded_appliance" | "outlet_cover" | "switch_plate" | "bathtub" | "toilet" | "dishwasher" | "oven" | "interior_door" | "door_handle" | "floor_tile" | "baseboard" | etc,
      "name": "Samsung RF28R7551SR Refrigerator" or "Standard Outlet Cover",
      "is_branded": true/false,
      "brand": "Samsung" (if branded),
      "model": "RF28R7551SR" (if visible),
      "search_query": "Samsung RF28R7551SR refrigerator dimensions specifications" (for branded items),
      "exact_dimension_inches": 4.5 (for standard items, null for branded until we search),
      "dimension_type": "height" | "width" | "depth" | "length",
      "bbox_pixels": { "top": 100, "left": 200, "bottom": 500, "right": 350 },
      "confidence": 0.95,
      "notes": "Clear view, full object visible"
    }
  ],
  "room_type": "kitchen" | "bathroom" | "bedroom" | "living_room" | "other",
  "best_object_index": 0,
  "detection_confidence": "high" | "medium" | "low"
}

IMPORTANT:
- Prefer branded products (we can look up exact specs)
- For standard fixtures, use the exact dimensions listed above
- Only return objects where you can clearly see the dimension being measured
- bbox_pixels should tightly bound the object
- Include ALL potential calibration objects found
- If analyzing multiple images, combine findings from all images`,
            },
            // Include all images (original photos are much better than 3D render)
            ...imageContent,
          ],
        },
      ],
      max_tokens: 2000,
      response_format: { type: 'json_object' },
    });
    
    const content = response.choices[0]?.message?.content || '{}';
    console.log('[Calibration] 🤖 Raw OpenAI Vision response:', content);
    
    const aiResult = JSON.parse(content);
    
    console.log('[Calibration] 📊 Parsed AI result:', JSON.stringify(aiResult, null, 2));
    console.log('[Calibration] AI detected', aiResult.objects?.length || 0, 'objects');
    
    if (!aiResult.objects || aiResult.objects.length === 0) {
      console.warn('[Calibration] ⚠️  No objects detected. Scene may not contain recognizable reference objects.');
      console.warn('[Calibration] 💡 Tip: Point camera at outlets, doors, appliances, or other standard fixtures.');
    }
    
    // Transform AI response to match frontend expectations
    const detectedObjects = (aiResult.objects || []).map((obj, index) => {
      // Look up standard dimension if not branded
      let knownDimensionValue = obj.exact_dimension_inches;
      let dimensionSource = obj.source || 'ai_detection';
      
      if (!obj.is_branded && !knownDimensionValue) {
        const stdDim = STANDARD_DIMENSIONS[obj.type];
        if (typeof stdDim === 'number') {
          knownDimensionValue = stdDim;
          dimensionSource = 'nema_standard';
        } else if (stdDim) {
          knownDimensionValue = stdDim[obj.dimension_type] || stdDim.height || stdDim.width;
          dimensionSource = 'building_code';
        }
      }
      
      // Calculate bounding box relative dimensions (0-1 range for frontend)
      const bboxPixels = obj.bbox_pixels || {};
      const imgWidth = 1920; // Assumed standard width
      const imgHeight = 1080; // Assumed standard height
      
      return {
        id: obj.id || `obj_${index + 1}`,
        name: obj.name || obj.type,
        type: obj.type,
        isBranded: obj.is_branded || false,
        brand: obj.brand || null,
        model: obj.model || null,
        searchQuery: obj.search_query || null,
        confidence: Math.round((obj.confidence || 0.5) * 100), // Convert to percentage
        knownDimension: knownDimensionValue ? {
          value: knownDimensionValue,
          unit: 'inches',
          type: obj.dimension_type || 'height',
          source: dimensionSource
        } : null,
        boundingBox: {
          top: (bboxPixels.top || 0) / imgHeight,
          left: (bboxPixels.left || 0) / imgWidth,
          bottom: (bboxPixels.bottom || imgHeight) / imgHeight,
          right: (bboxPixels.right || imgWidth) / imgWidth,
          width: ((bboxPixels.right || imgWidth) - (bboxPixels.left || 0)) / imgWidth,
          height: ((bboxPixels.bottom || imgHeight) - (bboxPixels.top || 0)) / imgHeight,
        },
        notes: obj.notes || ''
      };
    });
    
    // Sort by confidence and whether we have a known dimension
    detectedObjects.sort((a, b) => {
      // Prioritize objects with known dimensions
      if (a.knownDimension && !b.knownDimension) return -1;
      if (!a.knownDimension && b.knownDimension) return 1;
      // Then by confidence
      return b.confidence - a.confidence;
    });
    
    const responseData = {
      success: detectedObjects.length > 0,
      detectedObjects,
      roomType: aiResult.room_type || 'unknown',
      overallConfidence: aiResult.detection_confidence || 'medium',
      bestObjectIndex: 0, // First one after sorting
      scanId,
      usedOriginalImages,
      imageCount: imagesToAnalyze.length
    };
    
    console.log('[Calibration] Returning', detectedObjects.length, 'objects, best:', detectedObjects[0]?.name);
    console.log('[Calibration] Used original images:', usedOriginalImages, '- Image count:', imagesToAnalyze.length);
    res.json(responseData);
    
  } catch (error) {
    console.error('[Calibration] Detection error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Detection failed', 
      details: error.message,
      detectedObjects: []
    });
  }
});

// ============================================================================
// Product Specification Lookup Endpoint
// ============================================================================

router.post('/product-specs', async (req, res) => {
  try {
    const { productName, searchQuery } = req.body;
    
    if (!productName) {
      return res.status(400).json({ error: 'Product name required' });
    }
    
    console.log('[Calibration] Searching specs for:', productName);
    
    // Step 1: Google Search for product specifications
    const searchResults = await googleSearch(
      searchQuery || `${productName} dimensions specifications inches`
    );
    
    if (!searchResults || searchResults.length === 0) {
      console.log('[Calibration] No search results for:', productName);
      return res.json({ specification: null });
    }
    
    // Step 2: Use OpenAI to extract dimensions from search results
    const snippets = searchResults.slice(0, 5).map(r => ({
      title: r.title,
      snippet: r.snippet,
      link: r.link,
    }));
    
    const extractResponse = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'user',
          content: `Extract the EXACT product dimensions from these search results for: "${productName}"

Search Results:
${JSON.stringify(snippets, null, 2)}

Return JSON:
{
  "found": true/false,
  "product_name": "exact product name",
  "dimensions": {
    "height": 35.75 (number or null),
    "width": 35.875 (number or null),
    "depth": 36.5 (number or null),
    "unit": "inches" | "cm" | "mm"
  },
  "source": "manufacturer website name or source",
  "url": "source URL",
  "confidence": 0.95 (how confident you are these are correct)
}

IMPORTANT:
- Only return dimensions if you find EXACT specifications
- Prefer manufacturer specs over third-party
- Convert all measurements to a consistent unit
- Include the source URL for verification`,
        },
      ],
      max_tokens: 500,
      response_format: { type: 'json_object' },
    });
    
    const content = extractResponse.choices[0]?.message?.content || '{}';
    const result = JSON.parse(content);
    
    if (result.found && result.dimensions) {
      console.log('[Calibration] Found specs:', result.dimensions);
      res.json({
        specification: {
          productName: result.product_name || productName,
          dimensions: result.dimensions,
          source: result.source,
          url: result.url,
          confidence: result.confidence || 0.8,
        },
      });
    } else {
      console.log('[Calibration] Could not extract specs for:', productName);
      res.json({ specification: null });
    }
    
  } catch (error) {
    console.error('[Calibration] Spec lookup error:', error);
    res.status(500).json({ error: 'Spec lookup failed', details: error.message });
  }
});

// ============================================================================
// Google Search Helper
// ============================================================================

async function googleSearch(query) {
  if (!GOOGLE_API_KEY || !GOOGLE_CX) {
    console.warn('[Calibration] Google Search API not configured');
    return [];
  }
  
  try {
    const url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${GOOGLE_CX}&q=${encodeURIComponent(query)}&num=5`;
    
    const response = await fetch(url);
    
    if (!response.ok) {
      console.error('[Calibration] Google Search error:', response.status);
      return [];
    }
    
    const data = await response.json();
    
    return (data.items || []).map(item => ({
      title: item.title,
      snippet: item.snippet,
      link: item.link,
    }));
    
  } catch (error) {
    console.error('[Calibration] Google Search error:', error);
    return [];
  }
}

// ============================================================================
// Calibration Status Endpoint
// ============================================================================

router.get('/status/:scanId', async (req, res) => {
  try {
    const { scanId } = req.params;
    
    // TODO: Load calibration from database
    // For now, return not calibrated
    res.json({
      scanId,
      isCalibrated: false,
      calibration: null,
    });
    
  } catch (error) {
    res.status(500).json({ error: 'Failed to get calibration status' });
  }
});

// ============================================================================
// Save Calibration Endpoint
// ============================================================================

router.post('/save', async (req, res) => {
  try {
    const { scanId, calibration } = req.body;
    
    // TODO: Save calibration to database
    console.log('[Calibration] Saving calibration for scan:', scanId, calibration);
    
    res.json({
      success: true,
      scanId,
      calibration,
    });
    
  } catch (error) {
    res.status(500).json({ error: 'Failed to save calibration' });
  }
});

export default router;
