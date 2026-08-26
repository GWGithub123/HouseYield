/**
 * Renovation Planner Service
 * 
 * Professional renovation planning system:
 * 1. Create plan with room context + object specifications + exact dimensions
 * 2. Generate concept image using Nano Banana Pro (Image-to-Image or Text-to-Image)
 * 3. Convert concept to 3D model with dimension metadata
 * 4. Get cost and material estimates
 * 
 * All dimensions are tracked for accurate real-world planning.
 */

const API_BASE = '/api/renovation-planner';

// ============ Types ============

export interface Dimensions {
  width: number | null;
  height: number | null;
  depth: number | null;
  unit: 'inches' | 'cm';
}

export interface ObjectSpec {
  description: string;
  category: 'furniture' | 'fixture' | 'appliance' | 'structural';
  dimensions: Dimensions;
  materials: string[];
  finish: string | null;
}

export interface RoomContext {
  imageUrl: string | null;
  roomType: string;
  existingDimensions: Dimensions | null;
}

export interface CostEstimation {
  materialCost: number | null;
  laborCost: number | null;
  totalCost: number | null;
  estimatedHours: number | null;
  surfaceAreaSqIn: number | null;
  volumeCuFt: number | null;
  notes: string[];
}

export interface GeneratedAssets {
  conceptImageUrl: string | null;
  conceptImageLocalPath: string | null;
  model3dUrl: string | null;
  model3dLocalPath: string | null;
  thumbnailUrl: string | null;
}

export interface RenovationPlan {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: 'draft' | 'generating-concept' | 'concept-generated' | 'generating-3d' | '3d-generated' | 'finalized';
  roomContext: RoomContext;
  objectSpec: ObjectSpec;
  generatedAssets: GeneratedAssets;
  costEstimation: CostEstimation;
  tasks: {
    imageToImageTaskId: string | null;
    imageTo3dTaskId: string | null;
  };
}

export interface PlanSummary {
  id: string;
  description: string;
  status: string;
  dimensions: Dimensions;
  category: string;
  createdAt: string;
  updatedAt: string;
  hasConceptImage: boolean;
  has3dModel: boolean;
  costEstimation: CostEstimation | null;
}

export interface CreatePlanOptions {
  roomImageBase64?: string; // Base64 encoded room image (viewport capture)
  roomType?: string;
  description: string;
  category?: 'furniture' | 'fixture' | 'appliance' | 'structural';
  dimensions?: Partial<Dimensions>;
  materials?: string[];
  finish?: string;
}

export interface TaskStatus {
  taskId: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'CANCELED';
  progress: number;
  imageUrls?: string[];
  modelUrls?: { glb?: string; fbx?: string; usdz?: string };
  thumbnailUrl?: string;
}

// ============ Plan Management ============

/**
 * Create a new renovation plan
 */
export async function createPlan(options: CreatePlanOptions): Promise<{ plan: RenovationPlan }> {
  const response = await fetch(`${API_BASE}/create-plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to create plan');
  }

  return response.json();
}

/**
 * Get a renovation plan by ID
 */
export async function getPlan(planId: string): Promise<{ plan: RenovationPlan }> {
  const response = await fetch(`${API_BASE}/plan/${planId}`);

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to get plan');
  }

  return response.json();
}

/**
 * List all renovation plans
 */
export async function listPlans(): Promise<{ plans: PlanSummary[] }> {
  const response = await fetch(`${API_BASE}/plans`);

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to list plans');
  }

  return response.json();
}

/**
 * Delete a renovation plan
 */
export async function deletePlan(planId: string): Promise<void> {
  const response = await fetch(`${API_BASE}/plan/${planId}`, {
    method: 'DELETE',
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to delete plan');
  }
}

// ============ Concept Generation ============

/**
 * Start concept image generation for a plan
 */
export async function generateConcept(planId: string): Promise<{ taskId: string; taskType: string }> {
  const response = await fetch(`${API_BASE}/generate-concept/${planId}`, {
    method: 'POST',
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to start concept generation');
  }

  return response.json();
}

/**
 * Check concept generation status
 */
export async function getConceptStatus(planId: string): Promise<TaskStatus> {
  const response = await fetch(`${API_BASE}/concept-status/${planId}`);

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to get concept status');
  }

  return response.json();
}

/**
 * Save generated concept image locally
 */
export async function saveConcept(planId: string): Promise<{ conceptImagePath: string; conceptImageUrl: string }> {
  const response = await fetch(`${API_BASE}/save-concept/${planId}`, {
    method: 'POST',
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to save concept');
  }

  return response.json();
}

/**
 * Poll until concept is ready
 */
export async function pollConceptUntilDone(
  planId: string,
  onProgress?: (status: TaskStatus) => void,
  intervalMs: number = 2000,
  maxAttempts: number = 150
): Promise<TaskStatus> {
  let attempts = 0;

  while (attempts < maxAttempts) {
    const status = await getConceptStatus(planId);

    if (onProgress) {
      onProgress(status);
    }

    if (status.status === 'SUCCEEDED') {
      return status;
    }

    if (status.status === 'FAILED' || status.status === 'CANCELED') {
      throw new Error(`Concept generation ${status.status.toLowerCase()}`);
    }

    await new Promise(resolve => setTimeout(resolve, intervalMs));
    attempts++;
  }

  throw new Error('Concept generation timed out');
}

// ============ 3D Generation ============

/**
 * Start 3D model generation for a plan
 */
export async function generate3D(planId: string): Promise<{ taskId: string; dimensions: Dimensions }> {
  const response = await fetch(`${API_BASE}/generate-3d/${planId}`, {
    method: 'POST',
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to start 3D generation');
  }

  return response.json();
}

/**
 * Check 3D generation status
 */
export async function get3DStatus(planId: string): Promise<TaskStatus> {
  const response = await fetch(`${API_BASE}/3d-status/${planId}`);

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to get 3D status');
  }

  return response.json();
}

/**
 * Save generated 3D model locally
 */
export async function save3D(planId: string): Promise<{ 
  modelPath: string; 
  metadataPath: string;
  dimensions: Dimensions;
  thumbnailUrl: string;
}> {
  const response = await fetch(`${API_BASE}/save-3d/${planId}`, {
    method: 'POST',
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to save 3D model');
  }

  return response.json();
}

/**
 * Poll until 3D model is ready
 */
export async function poll3DUntilDone(
  planId: string,
  onProgress?: (status: TaskStatus) => void,
  intervalMs: number = 3000,
  maxAttempts: number = 200
): Promise<TaskStatus> {
  let attempts = 0;

  while (attempts < maxAttempts) {
    const status = await get3DStatus(planId);

    if (onProgress) {
      onProgress(status);
    }

    if (status.status === 'SUCCEEDED') {
      return status;
    }

    if (status.status === 'FAILED' || status.status === 'CANCELED') {
      throw new Error(`3D generation ${status.status.toLowerCase()}`);
    }

    await new Promise(resolve => setTimeout(resolve, intervalMs));
    attempts++;
  }

  throw new Error('3D generation timed out');
}

// ============ Cost Estimation ============

/**
 * Calculate cost and material estimates for a plan
 */
export async function estimateCost(planId: string): Promise<{ costEstimation: CostEstimation }> {
  const response = await fetch(`${API_BASE}/estimate-cost/${planId}`, {
    method: 'POST',
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to estimate cost');
  }

  return response.json();
}

// ============ Complete Pipeline ============

export interface PipelineProgress {
  stage: 'idle' | 'creating-plan' | 'generating-concept' | 'saving-concept' | 
         'generating-3d' | 'saving-3d' | 'estimating-cost' | 'complete' | 'error';
  planId?: string;
  conceptProgress?: number;
  model3dProgress?: number;
  conceptImagePath?: string;
  model3dPath?: string;
  costEstimation?: CostEstimation;
  error?: string;
}

/**
 * Run the complete renovation planning pipeline
 * 
 * 1. Create plan with specifications
 * 2. Generate concept image (with room context if provided)
 * 3. Convert to 3D model
 * 4. Calculate cost estimates
 */
export async function runRenovationPipeline(
  options: CreatePlanOptions,
  onProgress?: (progress: PipelineProgress) => void
): Promise<{
  planId: string;
  conceptImagePath: string;
  model3dPath: string;
  dimensions: Dimensions;
  costEstimation: CostEstimation;
}> {
  const updateProgress = (progress: Partial<PipelineProgress>) => {
    if (onProgress) {
      onProgress(progress as PipelineProgress);
    }
  };

  try {
    // Step 1: Create plan
    updateProgress({ stage: 'creating-plan' });
    const { plan } = await createPlan(options);
    const planId = plan.id;
    updateProgress({ stage: 'creating-plan', planId });

    // Step 2: Generate concept
    updateProgress({ stage: 'generating-concept', planId, conceptProgress: 0 });
    await generateConcept(planId);

    await pollConceptUntilDone(planId, (status) => {
      updateProgress({ 
        stage: 'generating-concept', 
        planId, 
        conceptProgress: status.progress 
      });
    });

    // Step 3: Save concept
    updateProgress({ stage: 'saving-concept', planId, conceptProgress: 100 });
    const { conceptImagePath } = await saveConcept(planId);
    updateProgress({ 
      stage: 'saving-concept', 
      planId, 
      conceptProgress: 100,
      conceptImagePath 
    });

    // Step 4: Generate 3D
    updateProgress({ 
      stage: 'generating-3d', 
      planId, 
      conceptImagePath,
      model3dProgress: 0 
    });
    await generate3D(planId);

    await poll3DUntilDone(planId, (status) => {
      updateProgress({ 
        stage: 'generating-3d', 
        planId, 
        conceptImagePath,
        model3dProgress: status.progress 
      });
    });

    // Step 5: Save 3D model
    updateProgress({ 
      stage: 'saving-3d', 
      planId, 
      conceptImagePath,
      model3dProgress: 100 
    });
    const { modelPath, dimensions } = await save3D(planId);

    // Step 6: Estimate costs
    updateProgress({ 
      stage: 'estimating-cost', 
      planId, 
      conceptImagePath,
      model3dPath: modelPath 
    });
    const { costEstimation } = await estimateCost(planId);

    // Complete
    updateProgress({ 
      stage: 'complete', 
      planId,
      conceptImagePath,
      model3dPath: modelPath,
      costEstimation 
    });

    return {
      planId,
      conceptImagePath,
      model3dPath: modelPath,
      dimensions,
      costEstimation,
    };

  } catch (error) {
    updateProgress({ 
      stage: 'error', 
      error: error instanceof Error ? error.message : String(error) 
    });
    throw error;
  }
}

// ============ Utility Functions ============

/**
 * Convert dimensions between units
 */
export function convertDimensions(dims: Dimensions, toUnit: 'inches' | 'cm'): Dimensions {
  if (dims.unit === toUnit) return dims;

  const factor = toUnit === 'cm' ? 2.54 : 1 / 2.54;

  return {
    width: dims.width ? dims.width * factor : null,
    height: dims.height ? dims.height * factor : null,
    depth: dims.depth ? dims.depth * factor : null,
    unit: toUnit,
  };
}

/**
 * Format dimensions for display
 */
export function formatDimensions(dims: Dimensions): string {
  if (!dims.width || !dims.height || !dims.depth) {
    return 'Dimensions not specified';
  }

  const unit = dims.unit === 'cm' ? 'cm' : '"';
  return `${dims.width}${unit} × ${dims.height}${unit} × ${dims.depth}${unit}`;
}

/**
 * Format cost for display
 */
export function formatCost(amount: number | null): string {
  if (amount === null) return 'N/A';
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Common material options for selection
 */
export const MATERIAL_OPTIONS = [
  { value: 'oak wood', label: 'Oak Wood', category: 'wood' },
  { value: 'pine wood', label: 'Pine Wood', category: 'wood' },
  { value: 'walnut wood', label: 'Walnut Wood', category: 'wood' },
  { value: 'mdf', label: 'MDF', category: 'wood' },
  { value: 'plywood', label: 'Plywood', category: 'wood' },
  { value: 'metal', label: 'Metal', category: 'metal' },
  { value: 'stainless steel', label: 'Stainless Steel', category: 'metal' },
  { value: 'brass', label: 'Brass', category: 'metal' },
  { value: 'glass', label: 'Glass', category: 'glass' },
  { value: 'marble', label: 'Marble', category: 'stone' },
  { value: 'granite', label: 'Granite', category: 'stone' },
  { value: 'laminate', label: 'Laminate', category: 'synthetic' },
  { value: 'fabric', label: 'Fabric', category: 'textile' },
  { value: 'leather', label: 'Leather', category: 'textile' },
];

/**
 * Finish options
 */
export const FINISH_OPTIONS = [
  { value: 'matte', label: 'Matte' },
  { value: 'satin', label: 'Satin' },
  { value: 'gloss', label: 'Gloss' },
  { value: 'natural', label: 'Natural' },
  { value: 'distressed', label: 'Distressed' },
  { value: 'painted', label: 'Painted' },
  { value: 'stained', label: 'Stained' },
];

/**
 * Room type options
 */
export const ROOM_TYPE_OPTIONS = [
  { value: 'living-room', label: 'Living Room' },
  { value: 'bedroom', label: 'Bedroom' },
  { value: 'kitchen', label: 'Kitchen' },
  { value: 'bathroom', label: 'Bathroom' },
  { value: 'dining-room', label: 'Dining Room' },
  { value: 'office', label: 'Office' },
  { value: 'garage', label: 'Garage' },
  { value: 'basement', label: 'Basement' },
  { value: 'outdoor', label: 'Outdoor/Patio' },
  { value: 'general', label: 'General' },
];

/**
 * Category options
 */
export const CATEGORY_OPTIONS = [
  { value: 'furniture', label: 'Furniture', description: 'Tables, chairs, cabinets, etc.' },
  { value: 'fixture', label: 'Fixture', description: 'Sinks, faucets, lighting, etc.' },
  { value: 'appliance', label: 'Appliance', description: 'Refrigerators, ovens, etc.' },
  { value: 'structural', label: 'Structural', description: 'Built-ins, countertops, etc.' },
];
