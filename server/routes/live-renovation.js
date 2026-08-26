/**
 * Live Renovation Assessment Routes
 * 
 * Real-time AI-guided renovation scanning endpoints.
 * Includes:
 * - Live frame analysis with GPT-4 Vision
 * - Metric3D depth estimation via Replicate API
 * - Session processing with measurements
 * - Cost estimation with actual quantities
 */

import express from 'express';
import OpenAI from 'openai';
import Replicate from 'replicate';
import { getDetailedCostEstimate } from '../zip-cost-estimator.js';
import { getLocalMarketData } from '../renovation-market-data.js';

const router = express.Router();

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Initialize Replicate for Metric3D
const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

// ============================================================================
// Live Frame Analysis
// ============================================================================

/**
 * POST /api/renovation/live-analyze
 * Analyze a camera frame in real-time for renovation opportunities
 */
router.post('/live-analyze', async (req, res) => {
  try {
    const { 
      frameData,    // Frontend sends frameData, not image
      image,        // Also accept image for backwards compat
      sessionContext = {},
      roomType: topLevelRoomType,
      captureCount: topLevelCaptureCount,
      coveragePercent: topLevelCoveragePercent,
      previousSuggestions = [],
    } = req.body;

    // Accept frameData or image
    const imageData = frameData || image;
    
    // Accept nested sessionContext or top-level params
    const roomType = sessionContext?.roomType || topLevelRoomType || 'other';
    const captureCount = sessionContext?.captureCount ?? topLevelCaptureCount ?? 0;
    const coveragePercent = sessionContext?.coveragePercent ?? topLevelCoveragePercent ?? 0;
    const recentTags = sessionContext?.recentTags || [];

    if (!imageData) {
      return res.status(400).json({ error: 'Image data required (frameData or image)' });
    }
    
    console.log('[LiveAnalyze] Processing frame - room:', roomType, 'captures:', captureCount, 'coverage:', coveragePercent);

    // Build context for the AI
    const contextInfo = `
Room type: ${roomType}
Captures so far: ${captureCount}
Coverage: ${coveragePercent}%
Previously identified: ${previousSuggestions.length > 0 ? previousSuggestions.join(', ') : 'None yet'}
Recently captured: ${recentTags.length > 0 ? recentTags.join(', ') : 'Nothing yet'}
`.trim();

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are a PROACTIVE renovation consultant actively watching a live room scan. You're like a helpful friend walking through the house with the user.

YOUR PERSONALITY:
- Enthusiastic and observant - "Ooh, I see those cabinets!"
- Give SPECIFIC observations about what you actually see
- Ask the user to show you specific things: "Can you show me the countertops closer?"
- Suggest movements: "Turn left to capture that window" or "Back up a bit for the full wall"

EVERY RESPONSE MUST:
1. Acknowledge what you see RIGHT NOW in specific terms (not generic)
2. Either praise what's good OR identify a renovation opportunity
3. Give a specific instruction about what to do next

EXAMPLE GUIDANCE MESSAGES:
- "Nice hardwood floors! Turn slowly to show me the baseboards."
- "I see dated cabinet hardware - let's capture that for replacement options."
- "Great coverage! Now show me the light fixtures above."
- "That outlet looks worn. Back up so I can see the whole wall."
- "Perfect shot of the window! Move right to get the adjacent wall."

Respond ONLY in valid JSON (no markdown):
{
  "guidance": {
    "type": "observation|instruction|suggestion|encouragement",
    "message": "Your SPECIFIC message about what you see (15-25 words)",
    "priority": "normal"
  },
  "focusRequest": null or {
    "targetType": "flooring|countertop|cabinets|fixtures|walls|ceiling|lighting|appliances|windows|doors",
    "message": "What to focus on",
    "reason": "Why it needs a closer look - be specific!"
  },
  "shouldCapture": true/false,
  "suggestedTag": "flooring|countertop|cabinets|fixtures|walls|ceiling|lighting|appliances|general",
  "detectedItems": ["specific", "items", "you", "see"],
  "preliminarySuggestion": null or {
    "type": "Renovation type",
    "description": "Specific suggestion based on what you see",
    "estimatedImpact": "low|medium|high"
  }
}`
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `What do you see in this frame? Give specific feedback.\n\n${contextInfo}`,
            },
            {
              type: 'image_url',
              image_url: {
                url: imageData.startsWith('data:') ? imageData : `data:image/jpeg;base64,${imageData}`,
                detail: 'high', // Use high detail for better analysis
              },
            },
          ],
        },
      ],
      max_tokens: 500,
      temperature: 0.3,
    });

    const content = response.choices[0]?.message?.content || '{}';
    const processingTimeMs = Date.now() - (new Date()).getTime();
    
    // Parse JSON response
    let gptResult;
    try {
      // Extract JSON from potential markdown code blocks
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, content];
      gptResult = JSON.parse(jsonMatch[1] || content);
    } catch (parseErr) {
      console.warn('[LiveAnalyze] Failed to parse AI response:', parseErr);
      gptResult = {
        guidance: {
          type: 'instruction',
          message: 'Continue scanning the room slowly',
          priority: 'low',
        },
        shouldCapture: false,
        detectedItems: [],
      };
    }

    // Transform GPT response to LiveAnalysisResponse format expected by frontend
    const response2 = {
      success: true,
      observations: gptResult.detectedItems || [],
      detectedRoomType: roomType,
      guidance: gptResult.guidance ? {
        id: `guidance_${Date.now()}`,
        type: gptResult.guidance.type || 'instruction',
        message: gptResult.guidance.message || '',
        priority: gptResult.guidance.priority || 'normal',
        timestamp: Date.now(),
      } : undefined,
      newFocusRequests: gptResult.focusRequest ? [{
        id: `focus_${Date.now()}`,
        target: gptResult.focusRequest.targetType || gptResult.focusRequest.message || 'area',
        reason: gptResult.focusRequest.reason || 'Needs closer inspection',
        suggestedTag: gptResult.suggestedTag || 'general',
        priority: 'normal',
        createdAt: Date.now(),
        status: 'pending',
        completedCaptures: [],
      }] : [],
      triggerCapture: gptResult.shouldCapture || false,
      captureTag: gptResult.suggestedTag || 'general',
      captureReason: gptResult.preliminarySuggestion?.description || 'AI identified renovation opportunity',
      preliminarySuggestions: gptResult.preliminarySuggestion ? [gptResult.preliminarySuggestion.description] : [],
      processingTimeMs: Date.now(),
    };
    
    console.log('[LiveAnalyze] Response:', JSON.stringify(response2, null, 2).slice(0, 500));

    res.json(response2);
  } catch (error) {
    console.error('[LiveAnalyze] Error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Live analysis failed',
      observations: [],
      guidance: {
        id: `guidance_${Date.now()}`,
        type: 'instruction',
        message: 'Continue scanning - AI temporarily unavailable',
        priority: 'low',
        timestamp: Date.now(),
      },
      processingTimeMs: 0,
    });
  }
});

// ============================================================================
// Metric3D Depth Estimation
// ============================================================================

/**
 * POST /api/renovation/metric3d-depth
 * Get metric depth map using Metric3D via Replicate
 */
router.post('/metric3d-depth', async (req, res) => {
  try {
    const { image } = req.body;

    if (!image) {
      return res.status(400).json({ error: 'Image data required' });
    }

    const startTime = Date.now();

    // Run Metric3D on Replicate
    // Using the Metric3D v2 model
    const output = await replicate.run(
      'cjwbw/metric3d-vit-large:4c3eca0d7ac80df1d5ec94ede3f1f7a60fd55b66d46b1ff5b8e02cf27b8b5bce',
      {
        input: {
          image: image.startsWith('data:') ? image : `data:image/jpeg;base64,${image}`,
        },
      }
    );

    const processingTime = Date.now() - startTime;

    // The output contains the depth map URL
    // We need to fetch it and return as base64
    let depthMapBase64 = null;
    let confidence = 0.85;

    if (output && output.depth_map) {
      // Fetch the depth map image
      const depthResponse = await fetch(output.depth_map);
      const depthBuffer = await depthResponse.arrayBuffer();
      depthMapBase64 = Buffer.from(depthBuffer).toString('base64');
      confidence = output.confidence || 0.85;
    }

    res.json({
      depthMap: depthMapBase64,
      confidence,
      processingTime,
      scaleFactor: 1.0,
    });
  } catch (error) {
    console.error('[Metric3D] Error:', error);
    res.status(500).json({ 
      error: 'Depth estimation failed',
      message: error.message,
    });
  }
});

// ============================================================================
// Session Processing
// ============================================================================

/**
 * POST /api/renovation/assess-from-scan
 * Process a complete renovation scan session with measurements
 */
router.post('/assess-from-scan', async (req, res) => {
  try {
    const {
      session,
      propertyId,
      address,
      zipCode,
    } = req.body;
    
    // Use session data as fallback
    const effectiveAddress = address || session?.address;
    const effectiveZipCode = zipCode || session?.zipCode;

    if (!session || !session.captures || session.captures.length === 0) {
      return res.status(400).json({ error: 'No captures in session' });
    }

    console.log(`[AssessFromScan] Processing ${session.captures.length} captures`);
    console.log(`[AssessFromScan] Address: ${effectiveAddress}, ZipCode: ${effectiveZipCode}`);

    // Collect all images for comprehensive analysis
    const captureImages = session.captures.slice(0, 12).map(capture => ({
      type: 'image_url',
      image_url: {
        url: capture.imageData.startsWith('data:') 
          ? capture.imageData 
          : `data:image/jpeg;base64,${capture.imageData}`,
        detail: 'high',
      },
    }));

    // Get measurements from session
    const measurements = session.measurements || {};
    const roomMeasurements = measurements.room;
    const objectMeasurements = measurements.objects || [];

    // Build measurement context
    let measurementContext = '';
    if (roomMeasurements) {
      const lengthFt = (roomMeasurements.length * 3.28084).toFixed(1);
      const widthFt = (roomMeasurements.width * 3.28084).toFixed(1);
      const heightFt = (roomMeasurements.height * 3.28084).toFixed(1);
      measurementContext = `
Room Dimensions (measured):
- Length: ${lengthFt} ft
- Width: ${widthFt} ft
- Height: ${heightFt} ft
- Floor Area: ~${(lengthFt * widthFt).toFixed(0)} sq ft

Object Measurements:
${objectMeasurements.map(m => {
  const wFt = (m.dimensions.width * 3.28084).toFixed(1);
  const hFt = (m.dimensions.height * 3.28084).toFixed(1);
  return `- ${m.objectType}: ${wFt}' x ${hFt}'`;
}).join('\n')}
`;
    }

    // Comprehensive renovation analysis with GPT-4 Vision
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are an expert renovation analyst. Analyze these room scan images and provide detailed renovation recommendations.

For each renovation, you MUST provide:
1. Specific type (e.g., "Replace Vinyl Flooring with LVP", not just "Flooring")
2. Detailed description of current condition and recommended work
3. Priority (1-5, where 1 is most urgent)
4. Impact level (how much it will improve the property)
5. Specific material recommendations
6. Quantity estimates based on room measurements

${measurementContext}

Respond in JSON format:
{
  "roomAssessment": {
    "overallCondition": "excellent|good|fair|poor",
    "cleanlinessScore": 1-10,
    "modernityScore": 1-10,
    "maintenanceNeeds": ["list of immediate maintenance needs"]
  },
  "renovations": [
    {
      "id": "unique-id",
      "type": "Specific Renovation Type",
      "category": "flooring|kitchen|bathroom|paint|electrical|plumbing|structural|cosmetic",
      "description": "Detailed description",
      "currentCondition": "Description of current state",
      "recommendation": "Specific recommendation",
      "priority": 1-5,
      "impact": "low|medium|high|transformative",
      "materials": {
        "primary": "Main material needed",
        "quantity": "Estimated quantity with unit",
        "alternatives": ["Alternative materials"]
      },
      "laborNotes": "Notes about labor complexity"
    }
  ],
  "quickWins": ["Low-cost high-impact improvements"],
  "majorProjects": ["Larger projects for maximum value"]
}`
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Analyze this ${session.roomType || 'room'} scan for renovation opportunities. 
Room name: ${session.roomName || 'Unknown'}
Property ID: ${propertyId || 'Not provided'}

${measurementContext ? `\nMeasurements:\n${measurementContext}` : ''}`,
            },
            ...captureImages,
          ],
        },
      ],
      max_tokens: 3000,
      temperature: 0.4,
    });

    const content = response.choices[0]?.message?.content || '{}';
    
    // Parse the analysis
    let analysis;
    try {
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, content];
      analysis = JSON.parse(jsonMatch[1] || content);
    } catch (parseErr) {
      console.error('[AssessFromScan] Failed to parse analysis:', parseErr);
      return res.status(500).json({ error: 'Failed to parse AI analysis' });
    }

    // Get market data if address provided
    let marketData = null;
    if (effectiveAddress) {
      try {
        marketData = await getLocalMarketData(effectiveAddress);
      } catch (marketErr) {
        console.warn('[AssessFromScan] Failed to get market data:', marketErr);
      }
    }

    // Calculate costs for each renovation
    const renovationsWithCosts = await Promise.all(
      (analysis.renovations || []).map(async (renovation) => {
        try {
          // Calculate quantities from measurements if available
          const quantities = calculateQuantitiesFromMeasurements(
            renovation,
            roomMeasurements,
            objectMeasurements
          );

          // Get cost estimate with actual measurements
          const costEstimate = await getDetailedCostEstimate(
            renovation.type,
            effectiveZipCode || '90210',
            {
              quantity: quantities.primary?.quantity || 100,
              unit: quantities.primary?.unit || 'sq ft',
              actualMeasurements: measurements,
            }
          );

          return {
            ...renovation,
            quantities,
            costEstimate: {
              materials: costEstimate.materialsCost || 0,
              labor: costEstimate.laborCost || 0,
              total: costEstimate.totalCost || 0,
              range: {
                low: costEstimate.lowEstimate || 0,
                high: costEstimate.highEstimate || 0,
              },
              breakdown: costEstimate.breakdown || [],
            },
            roi: marketData ? estimateROI(renovation, costEstimate, marketData) : null,
          };
        } catch (costErr) {
          console.warn(`[AssessFromScan] Cost estimation failed for ${renovation.type}:`, costErr);
          return {
            ...renovation,
            costEstimate: null,
          };
        }
      })
    );

    // Sort by priority
    renovationsWithCosts.sort((a, b) => a.priority - b.priority);

    // Build final response
    const result = {
      sessionId: session.id,
      roomName: session.roomName,
      roomType: session.roomType,
      captureCount: session.captures.length,
      measurements: {
        room: roomMeasurements,
        objects: objectMeasurements,
      },
      assessment: analysis.roomAssessment,
      renovations: renovationsWithCosts,
      quickWins: analysis.quickWins || [],
      majorProjects: analysis.majorProjects || [],
      marketData,
      totalEstimate: {
        low: renovationsWithCosts.reduce((sum, r) => sum + (r.costEstimate?.range?.low || 0), 0),
        high: renovationsWithCosts.reduce((sum, r) => sum + (r.costEstimate?.range?.high || 0), 0),
        recommended: renovationsWithCosts.reduce((sum, r) => sum + (r.costEstimate?.total || 0), 0),
      },
      generatedAt: new Date().toISOString(),
    };

    res.json(result);
  } catch (error) {
    console.error('[AssessFromScan] Error:', error);
    res.status(500).json({ 
      error: 'Assessment failed',
      message: error.message,
    });
  }
});

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Calculate material quantities from room measurements
 */
function calculateQuantitiesFromMeasurements(renovation, roomMeasurements, objectMeasurements) {
  const quantities = {};
  
  if (!roomMeasurements) {
    return quantities;
  }

  const lengthFt = roomMeasurements.length * 3.28084;
  const widthFt = roomMeasurements.width * 3.28084;
  const heightFt = roomMeasurements.height * 3.28084;
  const floorSqFt = lengthFt * widthFt;
  const wallSqFt = 2 * (lengthFt + widthFt) * heightFt;
  const linearFt = 2 * (lengthFt + widthFt);

  const category = renovation.category?.toLowerCase() || '';
  const type = renovation.type?.toLowerCase() || '';

  if (category === 'flooring' || type.includes('floor')) {
    quantities.primary = { quantity: Math.ceil(floorSqFt * 1.1), unit: 'sq ft' }; // 10% waste
    quantities.underlayment = { quantity: Math.ceil(floorSqFt), unit: 'sq ft' };
    quantities.baseboards = { quantity: Math.ceil(linearFt), unit: 'linear ft' };
  } else if (category === 'paint' || type.includes('paint')) {
    quantities.primary = { quantity: Math.ceil(wallSqFt / 350), unit: 'gallons' };
    quantities.primer = { quantity: Math.ceil(wallSqFt / 300), unit: 'gallons' };
  } else if (type.includes('countertop')) {
    // Look for countertop measurement
    const counterMeasurement = objectMeasurements?.find(m => 
      m.objectType === 'countertop' || m.objectType === 'counter'
    );
    if (counterMeasurement) {
      const sqFt = (counterMeasurement.dimensions.width * 3.28084) * 
                   (counterMeasurement.dimensions.depth * 3.28084);
      quantities.primary = { quantity: Math.ceil(sqFt), unit: 'sq ft' };
    } else {
      // Estimate based on room size (typical kitchen counter ratio)
      quantities.primary = { quantity: Math.ceil(floorSqFt * 0.25), unit: 'sq ft' };
    }
  } else if (type.includes('cabinet')) {
    quantities.primary = { quantity: Math.ceil(linearFt * 0.5), unit: 'linear ft' };
    quantities.upper = { quantity: Math.ceil(linearFt * 0.4), unit: 'linear ft' };
    quantities.lower = { quantity: Math.ceil(linearFt * 0.5), unit: 'linear ft' };
  } else if (category === 'bathroom' || type.includes('tile')) {
    quantities.primary = { quantity: Math.ceil(floorSqFt * 1.15), unit: 'sq ft' };
    quantities.showerTile = { quantity: 35, unit: 'sq ft' }; // Typical shower surround
  } else {
    // Default to floor area
    quantities.primary = { quantity: Math.ceil(floorSqFt), unit: 'sq ft' };
  }

  return quantities;
}

/**
 * Estimate ROI for a renovation based on market data
 */
function estimateROI(renovation, costEstimate, marketData) {
  if (!costEstimate || !marketData) return null;

  const totalCost = costEstimate.totalCost || 0;
  if (totalCost === 0) return null;

  // Base value increase percentages by category
  const valueIncreases = {
    kitchen: 0.80, // 80% of cost recovered
    bathroom: 0.70,
    flooring: 0.75,
    paint: 0.50,
    electrical: 0.60,
    plumbing: 0.60,
    structural: 0.90,
    cosmetic: 0.40,
  };

  const category = renovation.category?.toLowerCase() || 'cosmetic';
  const recoveryRate = valueIncreases[category] || 0.50;

  // Adjust for impact level
  const impactMultipliers = {
    low: 0.8,
    medium: 1.0,
    high: 1.2,
    transformative: 1.5,
  };
  const impactMultiplier = impactMultipliers[renovation.impact] || 1.0;

  const estimatedValueIncrease = totalCost * recoveryRate * impactMultiplier;
  const roi = ((estimatedValueIncrease - totalCost) / totalCost) * 100;

  // Estimate rent increase (typically lower than sale value increase)
  const rentIncreasePercent = (estimatedValueIncrease / (marketData.medianValue || 400000)) * 100 * 12;
  const monthlyRentIncrease = marketData.medianRent 
    ? marketData.medianRent * (rentIncreasePercent / 100)
    : null;

  return {
    estimatedValueIncrease: Math.round(estimatedValueIncrease),
    roi: Math.round(roi),
    paybackMonths: monthlyRentIncrease 
      ? Math.ceil(totalCost / monthlyRentIncrease)
      : null,
    monthlyRentIncrease: monthlyRentIncrease 
      ? Math.round(monthlyRentIncrease)
      : null,
  };
}

// ============================================================================
// Save Renovation Scan Results
// ============================================================================

/**
 * POST /api/renovation/save-scan-results
 * Save renovation scan results to Firestore for the Suggested Renovations page
 */
router.post('/save-scan-results', async (req, res) => {
  try {
    const {
      sessionId,
      roomName,
      roomType,
      address,
      zipCode,
      propertyId,
      measurements,
      assessment,
      renovations,
      quickWins,
      majorProjects,
      totalEstimate,
      captureCount,
      thumbnailImage,
      propertyImages,
    } = req.body;

    if (!sessionId || !renovations) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    console.log(`[SaveScanResults] Saving ${renovations.length} renovations for session ${sessionId}`);

    // Import Firebase Admin
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore();

    // Create the document to save
    const scanResult = {
      sessionId,
      roomName: roomName || 'Room',
      roomType: roomType || 'other',
      address: address || null,
      zipCode: zipCode || null,
      propertyId: propertyId || null,
      measurements: measurements || null,
      assessment: assessment || null,
      renovations: renovations.map(r => ({
        id: r.id,
        type: r.type,
        category: r.category,
        description: r.description,
        currentCondition: r.currentCondition,
        recommendation: r.recommendation,
        priority: r.priority,
        impact: r.impact,
        materials: r.materials || [],
        laborBreakdown: r.laborBreakdown || [],
        costEstimate: r.costEstimate,
        roi: r.roi,
        valueIncrease: r.valueIncrease || 0,
        rentIncreaseDollar: r.rentIncreaseDollar || 0,
        rentIncreasePercent: r.rentIncreasePercent || 0,
        paybackMonths: r.paybackMonths || null,
        timeframe: r.timeframe || '',
        confidence: r.confidence || null,
        shoppableProducts: r.shoppableProducts || null,
        previewImage: r.previewImage || null,
      })),
      quickWins: quickWins || [],
      majorProjects: majorProjects || [],
      totalEstimate: totalEstimate || null,
      captureCount: captureCount || 0,
      thumbnailImage: thumbnailImage || null,
      // Save up to 8 property images (base64 can be large, save first 200 chars as thumbnails or full URLs)
      propertyImages: (propertyImages || []).slice(0, 8).map(img => ({
        id: img.id,
        name: img.name,
        url: img.url,
      })),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Save to Firestore
    const docRef = await db.collection('renovation_scan_results').add(scanResult);
    
    console.log(`[SaveScanResults] ✅ Saved with ID: ${docRef.id}`);

    res.json({
      success: true,
      documentId: docRef.id,
      message: 'Renovation scan results saved successfully',
    });
  } catch (error) {
    console.error('[SaveScanResults] Error:', error);
    res.status(500).json({ 
      error: 'Failed to save renovation scan results',
      message: error.message,
    });
  }
});

/**
 * GET /api/renovation/saved-scan-results
 * Get all saved renovation scan results for the current user
 */
router.get('/saved-scan-results', async (req, res) => {
  try {
    const { propertyId, limit = 20 } = req.query;

    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore();

    let query = db.collection('renovation_scan_results')
      .orderBy('createdAt', 'desc')
      .limit(parseInt(limit));

    if (propertyId) {
      query = query.where('propertyId', '==', propertyId);
    }

    const snapshot = await query.get();
    const results = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.json({
      success: true,
      results,
      count: results.length,
    });
  } catch (error) {
    console.error('[GetSavedResults] Error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch saved renovation results',
      message: error.message,
    });
  }
});

export default router;
