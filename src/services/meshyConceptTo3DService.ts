/**
 * Meshy Text-to-Image + Concept-to-3D Service
 * 
 * Two-stage pipeline:
 * 1. Text → Image: Use Nano Banana Pro to generate a detailed concept image
 * 2. Image → 3D: Convert the concept image into a 3D model
 * 
 * This produces better results than direct Text-to-3D because:
 * - Nano Banana Pro creates highly detailed, realistic images
 * - You can preview and refine the concept before 3D conversion
 * - Image-to-3D uses the visual details for better 3D reconstruction
 */

const API_BASE = '/api/meshy/text-to-image';

// ============ Types ============

export interface TextToImageOptions {
  prompt: string;
  ai_model?: 'nano-banana' | 'nano-banana-pro';
  aspect_ratio?: '1:1' | '16:9' | '9:16' | '4:3' | '3:4';
  generate_multi_view?: boolean;
  pose_mode?: 'a-pose' | 't-pose' | null;
}

export interface TextToImageTask {
  id: string;
  type: 'text-to-image';
  ai_model: string;
  prompt: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'CANCELED';
  progress: number;
  created_at: number;
  started_at: number;
  finished_at: number;
  expires_at: number;
  image_urls?: string[];
  task_error?: { message: string };
}

export interface ConceptImage {
  filename: string;
  path: string;
  size?: number;
  createdAt?: string;
  originalUrl?: string;
}

export interface ConceptTo3DOptions {
  prompt: string;
  ai_model?: 'nano-banana' | 'nano-banana-pro';
  aspect_ratio?: '1:1' | '16:9' | '9:16' | '4:3' | '3:4';
  generate_multi_view?: boolean;
  // Image-to-3D options
  enable_pbr?: boolean;
  should_texture?: boolean;
  ai_model_3d?: string;
  topology?: 'triangle' | 'quad';
  target_polycount?: number;
}

export interface PipelineProgress {
  stage: 'idle' | 'generating-image' | 'image-complete' | 'generating-3d' | 'downloading' | 'complete' | 'error';
  imageTaskId?: string;
  modelTaskId?: string;
  imageProgress?: number;
  modelProgress?: number;
  conceptImage?: ConceptImage;
  finalModel?: { path: string; filename: string };
  error?: string;
}

// ============ Text-to-Image API ============

/**
 * Create a new Text-to-Image task
 */
export async function createTextToImageTask(options: TextToImageOptions): Promise<{ taskId: string }> {
  const response = await fetch(`${API_BASE}/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to create Text-to-Image task');
  }

  return response.json();
}

/**
 * Get task status
 */
export async function getImageTaskStatus(taskId: string): Promise<TextToImageTask> {
  const response = await fetch(`${API_BASE}/status/${taskId}`);
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to get task status');
  }

  return response.json();
}

/**
 * Download concept image(s) to local storage
 */
export async function downloadConceptImage(taskId: string): Promise<{ images: ConceptImage[] }> {
  const response = await fetch(`${API_BASE}/download/${taskId}`, {
    method: 'POST',
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to download concept image');
  }

  return response.json();
}

/**
 * Get list of saved concept images
 */
export async function getConceptImageLibrary(): Promise<{ images: ConceptImage[] }> {
  const response = await fetch(`${API_BASE}/library`);
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to get concept image library');
  }

  return response.json();
}

/**
 * Delete a concept image from library
 */
export async function deleteConceptImage(filename: string): Promise<void> {
  const response = await fetch(`${API_BASE}/library/${filename}`, {
    method: 'DELETE',
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to delete concept image');
  }
}

/**
 * Poll until image task completes
 */
export async function pollImageUntilDone(
  taskId: string,
  onProgress?: (task: TextToImageTask) => void,
  intervalMs: number = 2000,
  maxAttempts: number = 150 // 5 minutes max
): Promise<TextToImageTask> {
  let attempts = 0;
  
  while (attempts < maxAttempts) {
    const task = await getImageTaskStatus(taskId);
    
    if (onProgress) {
      onProgress(task);
    }
    
    if (task.status === 'SUCCEEDED') {
      return task;
    }
    
    if (task.status === 'FAILED' || task.status === 'CANCELED') {
      throw new Error(task.task_error?.message || `Task ${task.status.toLowerCase()}`);
    }
    
    await new Promise(resolve => setTimeout(resolve, intervalMs));
    attempts++;
  }
  
  throw new Error('Image generation timed out');
}

// ============ Image-to-3D API (reusing existing routes) ============

const IMAGE_TO_3D_API = '/api/meshy/image-to-3d';

export interface ImageTo3DTask {
  id: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'CANCELED';
  progress: number;
  model_urls?: { glb?: string; fbx?: string; usdz?: string };
  thumbnail_url?: string;
  task_error?: { message: string };
}

/**
 * Create Image-to-3D task from a concept image URL
 */
export async function createImageTo3DFromUrl(
  imageUrl: string,
  options: {
    enable_pbr?: boolean;
    should_texture?: boolean;
    should_remesh?: boolean;
    ai_model?: string;
    topology?: 'triangle' | 'quad';
    target_polycount?: number;
    texture_prompt?: string;
  } = {}
): Promise<{ taskId: string }> {
  const response = await fetch(`${API_BASE}/image-to-3d-from-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image_url: imageUrl,
      ...options,
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to create Image-to-3D task');
  }

  return response.json();
}

/**
 * Get 3D model task status
 */
export async function get3DTaskStatus(taskId: string): Promise<ImageTo3DTask> {
  const response = await fetch(`${IMAGE_TO_3D_API}/status/${taskId}`);
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to get 3D task status');
  }

  return response.json();
}

/**
 * Download 3D model
 */
export async function download3DModel(taskId: string): Promise<{ path: string; filename: string }> {
  const response = await fetch(`${IMAGE_TO_3D_API}/download/${taskId}`, {
    method: 'POST',
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to download 3D model');
  }

  return response.json();
}

/**
 * Poll until 3D task completes
 */
export async function poll3DUntilDone(
  taskId: string,
  onProgress?: (task: ImageTo3DTask) => void,
  intervalMs: number = 3000,
  maxAttempts: number = 200 // ~10 minutes max
): Promise<ImageTo3DTask> {
  let attempts = 0;
  
  while (attempts < maxAttempts) {
    const task = await get3DTaskStatus(taskId);
    
    if (onProgress) {
      onProgress(task);
    }
    
    if (task.status === 'SUCCEEDED') {
      return task;
    }
    
    if (task.status === 'FAILED' || task.status === 'CANCELED') {
      throw new Error(task.task_error?.message || `Task ${task.status.toLowerCase()}`);
    }
    
    await new Promise(resolve => setTimeout(resolve, intervalMs));
    attempts++;
  }
  
  throw new Error('3D generation timed out');
}

// ============ Complete Pipeline ============

/**
 * Complete Concept-to-3D Pipeline
 * 
 * 1. Generate concept image with Nano Banana Pro
 * 2. Download concept image locally
 * 3. Generate 3D model from concept image
 * 4. Download final 3D model
 * 
 * @param options Pipeline options
 * @param onProgress Callback for progress updates
 * @returns Final generated model info
 */
export async function runConceptTo3DPipeline(
  options: ConceptTo3DOptions,
  onProgress?: (progress: PipelineProgress) => void
): Promise<{ conceptImage: ConceptImage; finalModel: { path: string; filename: string } }> {
  
  const updateProgress = (progress: Partial<PipelineProgress>) => {
    if (onProgress) {
      onProgress(progress as PipelineProgress);
    }
  };

  try {
    // Stage 1: Generate concept image
    updateProgress({ stage: 'generating-image', imageProgress: 0 });
    
    const { taskId: imageTaskId } = await createTextToImageTask({
      prompt: options.prompt,
      ai_model: options.ai_model || 'nano-banana-pro',
      aspect_ratio: options.generate_multi_view ? undefined : (options.aspect_ratio || '1:1'),
      generate_multi_view: options.generate_multi_view,
    });

    updateProgress({ stage: 'generating-image', imageTaskId, imageProgress: 5 });

    // Poll until image is ready
    const imageTask = await pollImageUntilDone(imageTaskId, (task) => {
      updateProgress({ 
        stage: 'generating-image', 
        imageTaskId, 
        imageProgress: task.progress 
      });
    });

    // Download concept image
    const { images } = await downloadConceptImage(imageTaskId);
    const conceptImage = images[0]; // Use first image

    updateProgress({ 
      stage: 'image-complete', 
      imageTaskId,
      imageProgress: 100,
      conceptImage 
    });

    // Stage 2: Generate 3D model from concept image
    updateProgress({ 
      stage: 'generating-3d', 
      conceptImage,
      modelProgress: 0 
    });

    // Use the Meshy image URL directly (it's still valid for a while after generation)
    const imageUrl = imageTask.image_urls?.[0];
    if (!imageUrl) {
      throw new Error('No image URL available from concept generation');
    }

    const { taskId: modelTaskId } = await createImageTo3DFromUrl(imageUrl, {
      enable_pbr: options.enable_pbr ?? true,
      should_texture: options.should_texture ?? true,
      should_remesh: true,
      ai_model: options.ai_model_3d || 'latest',
      topology: options.topology || 'triangle',
      target_polycount: options.target_polycount || 30000,
    });

    updateProgress({ 
      stage: 'generating-3d', 
      conceptImage,
      modelTaskId, 
      modelProgress: 5 
    });

    // Poll until 3D model is ready
    await poll3DUntilDone(modelTaskId, (task) => {
      updateProgress({ 
        stage: 'generating-3d', 
        conceptImage,
        modelTaskId, 
        modelProgress: task.progress 
      });
    });

    // Download final model
    updateProgress({ 
      stage: 'downloading', 
      conceptImage,
      modelTaskId, 
      modelProgress: 100 
    });

    const finalModel = await download3DModel(modelTaskId);

    updateProgress({ 
      stage: 'complete', 
      conceptImage,
      finalModel,
      imageProgress: 100,
      modelProgress: 100
    });

    return { conceptImage, finalModel };

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
 * Generate optimized prompt for 3D object generation
 */
export function optimize3DPrompt(basePrompt: string): string {
  // Add 3D-friendly modifiers for better results
  const modifiers = [
    'product photography',
    'studio lighting',
    'isolated on white background',
    'clear details',
    'high quality',
    '3D render ready'
  ];
  
  return `${basePrompt}, ${modifiers.join(', ')}`;
}

/**
 * Get estimated time for pipeline stages
 */
export function getEstimatedTimes(options: ConceptTo3DOptions): {
  imageGeneration: string;
  modelGeneration: string;
  total: string;
} {
  const imageTime = options.ai_model === 'nano-banana-pro' ? '30-60s' : '15-30s';
  const modelTime = '2-5 min';
  
  return {
    imageGeneration: imageTime,
    modelGeneration: modelTime,
    total: '3-6 min'
  };
}
