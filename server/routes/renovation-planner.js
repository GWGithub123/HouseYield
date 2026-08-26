/**
 * Meshy Renovation Planner API Routes
 * 
 * Professional renovation planning system:
 * 1. Image-to-Image: Room context + text description → AI concept visualization
 * 2. Image-to-3D: Concept → Accurate 3D model with dimension specifications
 * 3. Dimension tracking for cost/material estimation
 * 
 * Uses Nano Banana Pro for high-quality, realistic concept generation
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

// Directories
const CONCEPT_IMAGES_DIR = path.join(__dirname, '../../public/renovation-concepts');
const GENERATED_OBJECTS_DIR = path.join(__dirname, '../../public/generated-objects');
const RENOVATION_PLANS_DIR = path.join(__dirname, '../../data/renovation-plans');

// Ensure directories exist
[CONCEPT_IMAGES_DIR, GENERATED_OBJECTS_DIR, RENOVATION_PLANS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

/**
 * Renovation Plan Schema
 * Tracks all details for cost estimation and project planning
 */
const createRenovationPlan = (data) => ({
  id: `reno_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  status: 'draft', // draft, concept-generated, 3d-generated, finalized
  
  // Room context
  roomContext: {
    imageUrl: data.roomImageUrl || null,
    roomType: data.roomType || 'general', // living-room, bedroom, kitchen, bathroom, etc.
    existingDimensions: data.existingDimensions || null, // Room dimensions if known
  },
  
  // Object to generate
  objectSpec: {
    description: data.description || '',
    category: data.category || 'furniture', // furniture, fixture, appliance, structural
    
    // Exact dimensions in inches (for US) or cm (for metric)
    dimensions: {
      width: data.dimensions?.width || null,
      height: data.dimensions?.height || null,
      depth: data.dimensions?.depth || null,
      unit: data.dimensions?.unit || 'inches', // 'inches' or 'cm'
    },
    
    // Material specifications for cost estimation
    materials: data.materials || [], // e.g., ['oak wood', 'brass hardware']
    finish: data.finish || null, // e.g., 'matte', 'gloss', 'natural'
  },
  
  // Generated assets
  generatedAssets: {
    conceptImageUrl: null,
    conceptImageLocalPath: null,
    model3dUrl: null,
    model3dLocalPath: null,
    thumbnailUrl: null,
  },
  
  // Cost estimation (populated after 3D generation)
  costEstimation: {
    materialCost: null,
    laborCost: null,
    totalCost: null,
    estimatedHours: null,
    notes: [],
  },
  
  // Task tracking
  tasks: {
    imageToImageTaskId: null,
    imageTo3dTaskId: null,
  }
});

/**
 * POST /create-plan
 * Create a new renovation plan with room context and object specifications
 */
router.post('/create-plan', async (req, res) => {
  try {
    const {
      roomImageBase64, // Base64 of room image (viewport capture)
      roomType,
      description,
      category,
      dimensions,
      materials,
      finish,
    } = req.body;

    if (!description) {
      return res.status(400).json({ error: 'Object description is required' });
    }

    // Create the plan
    const plan = createRenovationPlan({
      roomImageUrl: roomImageBase64 ? `data:image/png;base64,${roomImageBase64.replace(/^data:image\/\w+;base64,/, '')}` : null,
      roomType,
      description,
      category,
      dimensions,
      materials,
      finish,
    });

    // Save the plan
    const planPath = path.join(RENOVATION_PLANS_DIR, `${plan.id}.json`);
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));

    console.log('[Renovation] Plan created:', plan.id);
    res.json({ 
      success: true,
      plan,
      message: 'Renovation plan created successfully'
    });

  } catch (error) {
    console.error('[Renovation] Error creating plan:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /generate-concept/:planId
 * Step 1: Generate concept image using room context + description
 * Uses Image-to-Image API with Nano Banana Pro
 */
router.post('/generate-concept/:planId', async (req, res) => {
  try {
    const apiKey = getApiKey();
    if (!apiKey) {
      return res.status(500).json({ error: 'Meshy API key not configured' });
    }

    const { planId } = req.params;
    const planPath = path.join(RENOVATION_PLANS_DIR, `${planId}.json`);

    if (!fs.existsSync(planPath)) {
      return res.status(404).json({ error: 'Renovation plan not found' });
    }

    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));

    // Build the prompt with dimension context
    let prompt = plan.objectSpec.description;
    
    // Add dimension context to prompt for better generation
    const dims = plan.objectSpec.dimensions;
    if (dims.width && dims.height && dims.depth) {
      const unit = dims.unit === 'cm' ? 'centimeters' : 'inches';
      prompt += `. Exact dimensions: ${dims.width}${unit} wide × ${dims.height}${unit} tall × ${dims.depth}${unit} deep`;
    }
    
    // Add material context
    if (plan.objectSpec.materials?.length > 0) {
      prompt += `. Materials: ${plan.objectSpec.materials.join(', ')}`;
    }
    
    if (plan.objectSpec.finish) {
      prompt += `. Finish: ${plan.objectSpec.finish}`;
    }

    // Add professional context for renovation planning
    prompt += '. Professional product photography, studio lighting, accurate proportions for renovation planning, photorealistic, high detail';

    console.log('[Renovation] Generating concept with prompt:', prompt);

    // Check if we have room context
    const hasRoomContext = plan.roomContext.imageUrl;
    
    let response;
    let taskType;

    if (hasRoomContext) {
      // Use Image-to-Image with room context
      taskType = 'image-to-image';
      response = await fetch(`${MESHY_API_URL}/image-to-image`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          ai_model: 'nano-banana-pro',
          prompt,
          reference_image_urls: [plan.roomContext.imageUrl],
        })
      });
    } else {
      // Use Text-to-Image without room context
      taskType = 'text-to-image';
      response = await fetch(`${MESHY_API_URL}/text-to-image`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          ai_model: 'nano-banana-pro',
          prompt,
          aspect_ratio: '1:1',
        })
      });
    }

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || 'Failed to create concept task');
    }

    const taskId = data.result;

    // Update plan with task info
    plan.tasks.imageToImageTaskId = taskId;
    plan.status = 'generating-concept';
    plan.updatedAt = new Date().toISOString();
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));

    console.log('[Renovation] Concept task created:', taskId, 'Type:', taskType);

    res.json({
      success: true,
      taskId,
      taskType,
      planId: plan.id,
      message: 'Concept generation started'
    });

  } catch (error) {
    console.error('[Renovation] Error generating concept:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /concept-status/:planId
 * Check status of concept generation
 */
router.get('/concept-status/:planId', async (req, res) => {
  try {
    const apiKey = getApiKey();
    if (!apiKey) {
      return res.status(500).json({ error: 'Meshy API key not configured' });
    }

    const { planId } = req.params;
    const planPath = path.join(RENOVATION_PLANS_DIR, `${planId}.json`);

    if (!fs.existsSync(planPath)) {
      return res.status(404).json({ error: 'Renovation plan not found' });
    }

    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    const taskId = plan.tasks.imageToImageTaskId;

    if (!taskId) {
      return res.status(400).json({ error: 'No concept generation task found' });
    }

    // Determine which API to poll based on whether we had room context
    const endpoint = plan.roomContext.imageUrl 
      ? `${MESHY_API_URL}/image-to-image/${taskId}`
      : `${MESHY_API_URL}/text-to-image/${taskId}`;

    const response = await fetch(endpoint, {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || 'Failed to get task status');
    }

    res.json({
      taskId,
      status: data.status,
      progress: data.progress,
      imageUrls: data.image_urls,
    });

  } catch (error) {
    console.error('[Renovation] Error checking concept status:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /save-concept/:planId
 * Download and save the generated concept image
 */
router.post('/save-concept/:planId', async (req, res) => {
  try {
    const apiKey = getApiKey();
    if (!apiKey) {
      return res.status(500).json({ error: 'Meshy API key not configured' });
    }

    const { planId } = req.params;
    const planPath = path.join(RENOVATION_PLANS_DIR, `${planId}.json`);

    if (!fs.existsSync(planPath)) {
      return res.status(404).json({ error: 'Renovation plan not found' });
    }

    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    const taskId = plan.tasks.imageToImageTaskId;

    // Get task status to retrieve image URL
    const endpoint = plan.roomContext.imageUrl 
      ? `${MESHY_API_URL}/image-to-image/${taskId}`
      : `${MESHY_API_URL}/text-to-image/${taskId}`;

    const statusResponse = await fetch(endpoint, {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });

    const statusData = await statusResponse.json();

    if (statusData.status !== 'SUCCEEDED') {
      return res.status(400).json({ error: 'Concept not ready yet', status: statusData.status });
    }

    const imageUrl = statusData.image_urls?.[0];
    if (!imageUrl) {
      return res.status(400).json({ error: 'No image URL available' });
    }

    // Download the image
    const imageResponse = await fetch(imageUrl);
    const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());

    // Save locally
    const filename = `concept_${planId}_${Date.now()}.png`;
    const localPath = path.join(CONCEPT_IMAGES_DIR, filename);
    fs.writeFileSync(localPath, imageBuffer);

    // Update plan
    plan.generatedAssets.conceptImageUrl = imageUrl;
    plan.generatedAssets.conceptImageLocalPath = `/renovation-concepts/${filename}`;
    plan.status = 'concept-generated';
    plan.updatedAt = new Date().toISOString();
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));

    console.log('[Renovation] Concept saved:', localPath);

    res.json({
      success: true,
      conceptImagePath: `/renovation-concepts/${filename}`,
      conceptImageUrl: imageUrl,
    });

  } catch (error) {
    console.error('[Renovation] Error saving concept:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /generate-3d/:planId
 * Step 2: Convert concept to 3D model with dimension specifications
 */
router.post('/generate-3d/:planId', async (req, res) => {
  try {
    const apiKey = getApiKey();
    if (!apiKey) {
      return res.status(500).json({ error: 'Meshy API key not configured' });
    }

    const { planId } = req.params;
    const planPath = path.join(RENOVATION_PLANS_DIR, `${planId}.json`);

    if (!fs.existsSync(planPath)) {
      return res.status(404).json({ error: 'Renovation plan not found' });
    }

    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));

    if (!plan.generatedAssets.conceptImageUrl) {
      return res.status(400).json({ error: 'Generate concept first' });
    }

    // Build texture prompt with dimension context for accurate 3D
    let texturePrompt = plan.objectSpec.description;
    
    // Note: Meshy doesn't directly support dimension input for 3D,
    // but we include it in the texture prompt for better context
    // The actual scaling is done client-side when placing the object
    const dims = plan.objectSpec.dimensions;
    if (dims.width && dims.height && dims.depth) {
      texturePrompt += `. Proportions: ${dims.width}:${dims.height}:${dims.depth}`;
    }

    if (plan.objectSpec.materials?.length > 0) {
      texturePrompt += `. Material texture: ${plan.objectSpec.materials.join(', ')}`;
    }

    // Calculate optimal poly count based on object complexity
    // Larger objects need more detail
    let targetPolycount = 30000;
    if (dims.width && dims.height && dims.depth) {
      const volume = dims.width * dims.height * dims.depth;
      if (volume > 50000) targetPolycount = 50000; // Large objects
      if (volume > 200000) targetPolycount = 80000; // Very large objects
    }

    console.log('[Renovation] Generating 3D with texture prompt:', texturePrompt);

    const response = await fetch(`${MESHY_API_URL}/image-to-3d`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        image_url: plan.generatedAssets.conceptImageUrl,
        enable_pbr: true,
        should_texture: true,
        should_remesh: true,
        ai_model: 'latest', // Meshy 6
        topology: 'triangle',
        target_polycount: targetPolycount,
        texture_prompt: texturePrompt,
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || 'Failed to create 3D task');
    }

    const taskId = data.result;

    // Update plan
    plan.tasks.imageTo3dTaskId = taskId;
    plan.status = 'generating-3d';
    plan.updatedAt = new Date().toISOString();
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));

    console.log('[Renovation] 3D task created:', taskId);

    res.json({
      success: true,
      taskId,
      planId: plan.id,
      dimensions: plan.objectSpec.dimensions,
      message: '3D generation started'
    });

  } catch (error) {
    console.error('[Renovation] Error generating 3D:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /3d-status/:planId
 * Check status of 3D generation
 */
router.get('/3d-status/:planId', async (req, res) => {
  try {
    const apiKey = getApiKey();
    if (!apiKey) {
      return res.status(500).json({ error: 'Meshy API key not configured' });
    }

    const { planId } = req.params;
    const planPath = path.join(RENOVATION_PLANS_DIR, `${planId}.json`);

    if (!fs.existsSync(planPath)) {
      return res.status(404).json({ error: 'Renovation plan not found' });
    }

    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    const taskId = plan.tasks.imageTo3dTaskId;

    if (!taskId) {
      return res.status(400).json({ error: 'No 3D generation task found' });
    }

    const response = await fetch(`${MESHY_API_URL}/image-to-3d/${taskId}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || 'Failed to get task status');
    }

    res.json({
      taskId,
      status: data.status,
      progress: data.progress,
      modelUrls: data.model_urls,
      thumbnailUrl: data.thumbnail_url,
    });

  } catch (error) {
    console.error('[Renovation] Error checking 3D status:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /save-3d/:planId
 * Download and save the generated 3D model with dimension metadata
 */
router.post('/save-3d/:planId', async (req, res) => {
  try {
    const apiKey = getApiKey();
    if (!apiKey) {
      return res.status(500).json({ error: 'Meshy API key not configured' });
    }

    const { planId } = req.params;
    const planPath = path.join(RENOVATION_PLANS_DIR, `${planId}.json`);

    if (!fs.existsSync(planPath)) {
      return res.status(404).json({ error: 'Renovation plan not found' });
    }

    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    const taskId = plan.tasks.imageTo3dTaskId;

    // Get task status
    const response = await fetch(`${MESHY_API_URL}/image-to-3d/${taskId}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });

    const data = await response.json();

    if (data.status !== 'SUCCEEDED') {
      return res.status(400).json({ error: '3D model not ready yet', status: data.status });
    }

    const glbUrl = data.model_urls?.glb;
    if (!glbUrl) {
      return res.status(400).json({ error: 'No GLB URL available' });
    }

    // Download the model
    const modelResponse = await fetch(glbUrl);
    const modelBuffer = Buffer.from(await modelResponse.arrayBuffer());

    // Create filename with dimension info
    const dims = plan.objectSpec.dimensions;
    const dimStr = dims.width && dims.height && dims.depth 
      ? `_${dims.width}x${dims.height}x${dims.depth}${dims.unit === 'cm' ? 'cm' : 'in'}`
      : '';
    
    const sanitizedDesc = plan.objectSpec.description
      .replace(/[^a-zA-Z0-9\s]/g, '')
      .replace(/\s+/g, '_')
      .substring(0, 30);
    
    const filename = `${sanitizedDesc}${dimStr}_${Date.now()}.glb`;
    const localPath = path.join(GENERATED_OBJECTS_DIR, filename);
    fs.writeFileSync(localPath, modelBuffer);

    // Save dimension metadata alongside the model
    const metadataPath = localPath.replace('.glb', '_metadata.json');
    const metadata = {
      planId: plan.id,
      description: plan.objectSpec.description,
      dimensions: plan.objectSpec.dimensions,
      materials: plan.objectSpec.materials,
      finish: plan.objectSpec.finish,
      category: plan.objectSpec.category,
      createdAt: new Date().toISOString(),
      meshyTaskId: taskId,
    };
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

    // Update plan
    plan.generatedAssets.model3dUrl = glbUrl;
    plan.generatedAssets.model3dLocalPath = `/generated-objects/${filename}`;
    plan.generatedAssets.thumbnailUrl = data.thumbnail_url;
    plan.status = '3d-generated';
    plan.updatedAt = new Date().toISOString();
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));

    console.log('[Renovation] 3D model saved:', localPath);

    res.json({
      success: true,
      modelPath: `/generated-objects/${filename}`,
      metadataPath: `/generated-objects/${filename.replace('.glb', '_metadata.json')}`,
      dimensions: plan.objectSpec.dimensions,
      thumbnailUrl: data.thumbnail_url,
    });

  } catch (error) {
    console.error('[Renovation] Error saving 3D:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /estimate-cost/:planId
 * Calculate material and labor cost estimates based on dimensions
 */
router.post('/estimate-cost/:planId', async (req, res) => {
  try {
    const { planId } = req.params;
    const planPath = path.join(RENOVATION_PLANS_DIR, `${planId}.json`);

    if (!fs.existsSync(planPath)) {
      return res.status(404).json({ error: 'Renovation plan not found' });
    }

    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    const dims = plan.objectSpec.dimensions;

    // Convert to consistent unit (inches) for calculation
    let width = dims.width || 0;
    let height = dims.height || 0;
    let depth = dims.depth || 0;
    
    if (dims.unit === 'cm') {
      width = width / 2.54;
      height = height / 2.54;
      depth = depth / 2.54;
    }

    // Calculate surface area and volume
    const surfaceArea = 2 * (width * height + height * depth + width * depth);
    const volume = width * height * depth;
    const volumeCuFt = volume / 1728; // Convert cubic inches to cubic feet

    // Base cost estimations (these would be configurable in a real system)
    const materialCosts = {
      'oak wood': 15, // per board foot
      'pine wood': 8,
      'walnut wood': 25,
      'mdf': 5,
      'plywood': 7,
      'metal': 20,
      'glass': 30,
      'marble': 50,
      'granite': 45,
      'laminate': 3,
      'default': 10,
    };

    const laborRates = {
      furniture: 75, // per hour
      fixture: 85,
      appliance: 95,
      structural: 120,
      default: 80,
    };

    // Calculate material cost
    let materialCost = 0;
    const materialsUsed = plan.objectSpec.materials || ['default'];
    materialsUsed.forEach(mat => {
      const costPerUnit = materialCosts[mat.toLowerCase()] || materialCosts.default;
      materialCost += costPerUnit * volumeCuFt;
    });

    // Add 20% for waste/error margin
    materialCost *= 1.2;

    // Estimate labor hours based on complexity
    const category = plan.objectSpec.category || 'default';
    const laborRate = laborRates[category] || laborRates.default;
    
    // Base hours on size and complexity
    let estimatedHours = 2; // Base time
    estimatedHours += volumeCuFt * 0.5; // Add time for size
    if (plan.objectSpec.finish) estimatedHours += 1; // Add for finishing
    if (materialsUsed.length > 1) estimatedHours += 0.5 * materialsUsed.length; // Multiple materials

    const laborCost = estimatedHours * laborRate;
    const totalCost = materialCost + laborCost;

    // Update plan with estimates
    plan.costEstimation = {
      materialCost: Math.round(materialCost * 100) / 100,
      laborCost: Math.round(laborCost * 100) / 100,
      totalCost: Math.round(totalCost * 100) / 100,
      estimatedHours: Math.round(estimatedHours * 10) / 10,
      surfaceAreaSqIn: Math.round(surfaceArea * 100) / 100,
      volumeCuFt: Math.round(volumeCuFt * 100) / 100,
      notes: [
        `Based on ${materialsUsed.join(', ')} materials`,
        `Category: ${category}`,
        `Labor rate: $${laborRate}/hour`,
        'Includes 20% material waste buffer',
      ],
    };
    plan.updatedAt = new Date().toISOString();
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));

    res.json({
      success: true,
      costEstimation: plan.costEstimation,
    });

  } catch (error) {
    console.error('[Renovation] Error estimating cost:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /plan/:planId
 * Get full renovation plan details
 */
router.get('/plan/:planId', async (req, res) => {
  try {
    const { planId } = req.params;
    const planPath = path.join(RENOVATION_PLANS_DIR, `${planId}.json`);

    if (!fs.existsSync(planPath)) {
      return res.status(404).json({ error: 'Renovation plan not found' });
    }

    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    res.json({ success: true, plan });

  } catch (error) {
    console.error('[Renovation] Error getting plan:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /plans
 * List all renovation plans
 */
router.get('/plans', async (req, res) => {
  try {
    if (!fs.existsSync(RENOVATION_PLANS_DIR)) {
      return res.json({ plans: [] });
    }

    const files = fs.readdirSync(RENOVATION_PLANS_DIR);
    const plans = files
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const planPath = path.join(RENOVATION_PLANS_DIR, f);
        const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
        return {
          id: plan.id,
          description: plan.objectSpec.description,
          status: plan.status,
          dimensions: plan.objectSpec.dimensions,
          category: plan.objectSpec.category,
          createdAt: plan.createdAt,
          updatedAt: plan.updatedAt,
          hasConceptImage: !!plan.generatedAssets.conceptImageLocalPath,
          has3dModel: !!plan.generatedAssets.model3dLocalPath,
          costEstimation: plan.costEstimation,
        };
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json({ plans });

  } catch (error) {
    console.error('[Renovation] Error listing plans:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /plan/:planId
 * Delete a renovation plan and its assets
 */
router.delete('/plan/:planId', async (req, res) => {
  try {
    const { planId } = req.params;
    const planPath = path.join(RENOVATION_PLANS_DIR, `${planId}.json`);

    if (!fs.existsSync(planPath)) {
      return res.status(404).json({ error: 'Renovation plan not found' });
    }

    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));

    // Delete associated files
    if (plan.generatedAssets.conceptImageLocalPath) {
      const conceptPath = path.join(__dirname, '../../public', plan.generatedAssets.conceptImageLocalPath);
      if (fs.existsSync(conceptPath)) fs.unlinkSync(conceptPath);
    }

    if (plan.generatedAssets.model3dLocalPath) {
      const modelPath = path.join(__dirname, '../../public', plan.generatedAssets.model3dLocalPath);
      if (fs.existsSync(modelPath)) fs.unlinkSync(modelPath);
      
      // Also delete metadata
      const metadataPath = modelPath.replace('.glb', '_metadata.json');
      if (fs.existsSync(metadataPath)) fs.unlinkSync(metadataPath);
    }

    // Delete the plan
    fs.unlinkSync(planPath);

    res.json({ success: true, message: 'Plan deleted' });

  } catch (error) {
    console.error('[Renovation] Error deleting plan:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
