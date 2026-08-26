/**
 * Meshy Image-to-3D Service
 * 
 * Frontend service for generating 3D objects from captured viewport images
 * Integrates with Three.js renderer to capture current view and send to Meshy AI
 */

// ============== Types ==============

export interface ImageTo3DOptions {
  enable_pbr?: boolean;        // Generate PBR maps (metallic, roughness, normal)
  should_texture?: boolean;    // Generate textures (default true)
  should_remesh?: boolean;     // Apply remeshing (default true)
  ai_model?: 'meshy-4' | 'meshy-5' | 'latest';  // AI model to use
  topology?: 'quad' | 'triangle';  // Mesh topology
  target_polycount?: number;   // Target polygon count (100-300,000)
}

export interface ImageTo3DTask {
  taskId: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'CANCELED';
  progress: number;
  model_urls?: {
    glb?: string;
    fbx?: string;
    obj?: string;
    usdz?: string;
    mtl?: string;
  };
  thumbnail_url?: string;
  texture_urls?: Array<{
    base_color?: string;
    metallic?: string;
    normal?: string;
    roughness?: string;
  }>;
  error?: string | null;
}

export interface GeneratedObject {
  filename: string;
  path: string;
  thumbnail: string | null;
  size: number;
  createdAt: string;
  source: 'viewport-capture' | 'text-prompt';
}

// ============== API Functions ==============

const API_BASE = '/api/meshy/image-to-3d';

/**
 * Create a new Image-to-3D task from a captured image
 * @param imageData Base64 data URI or URL of the image
 * @param description Text description of the object (helps with texturing)
 * @param options Generation options
 */
export async function createImageTo3DTask(
  imageData: string,
  description?: string,
  options?: ImageTo3DOptions
): Promise<{ success: boolean; taskId?: string; error?: string }> {
  try {
    const response = await fetch(`${API_BASE}/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageData,
        description,
        options: {
          enable_pbr: true,
          should_texture: true,
          should_remesh: true,
          ai_model: 'latest',
          topology: 'triangle',
          target_polycount: 30000,
          ...options,
        },
      }),
    });

    const data = await response.json();
    return data;
  } catch (error) {
    console.error('[Image-to-3D] Create task error:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

/**
 * Get the status of an Image-to-3D task
 */
export async function getTaskStatus(taskId: string): Promise<ImageTo3DTask | null> {
  try {
    const response = await fetch(`${API_BASE}/status/${taskId}`);
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    console.error('[Image-to-3D] Get status error:', error);
    return null;
  }
}

/**
 * Download the completed model to local storage
 */
export async function downloadModel(
  taskId: string,
  format: 'glb' | 'fbx' | 'obj' | 'usdz' = 'glb'
): Promise<{ success: boolean; localPath?: string; thumbnailPath?: string; error?: string }> {
  try {
    const response = await fetch(`${API_BASE}/download/${taskId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ format }),
    });

    const data = await response.json();
    return data;
  } catch (error) {
    console.error('[Image-to-3D] Download error:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

/**
 * Get list of active tasks
 */
export async function getActiveTasks(): Promise<ImageTo3DTask[]> {
  try {
    const response = await fetch(`${API_BASE}/tasks`);
    if (!response.ok) return [];
    const data = await response.json();
    return data.tasks || [];
  } catch (error) {
    console.error('[Image-to-3D] Get tasks error:', error);
    return [];
  }
}

/**
 * Get library of generated objects
 */
export async function getLibrary(): Promise<GeneratedObject[]> {
  try {
    const response = await fetch(`${API_BASE}/library`);
    if (!response.ok) return [];
    const data = await response.json();
    return data.objects || [];
  } catch (error) {
    console.error('[Image-to-3D] Get library error:', error);
    return [];
  }
}

// ============== Viewport Capture Utilities ==============

/**
 * Capture the current Three.js renderer view as a base64 data URI
 * @param renderer The Three.js WebGLRenderer
 * @param format Image format ('png' or 'jpeg')
 * @param quality JPEG quality (0-1), only used for 'jpeg' format
 */
export function captureViewport(
  renderer: { domElement: HTMLCanvasElement },
  format: 'png' | 'jpeg' = 'png',
  quality: number = 0.9
): string {
  const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
  return renderer.domElement.toDataURL(mimeType, quality);
}

/**
 * Capture a specific region of the viewport
 * @param renderer The Three.js WebGLRenderer
 * @param x X coordinate of the region (in pixels from left)
 * @param y Y coordinate of the region (in pixels from top)
 * @param width Width of the region
 * @param height Height of the region
 */
export function captureViewportRegion(
  renderer: { domElement: HTMLCanvasElement },
  x: number,
  y: number,
  width: number,
  height: number
): string {
  const canvas = renderer.domElement;
  
  // Create a temporary canvas for the cropped region
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = width;
  tempCanvas.height = height;
  
  const ctx = tempCanvas.getContext('2d');
  if (!ctx) {
    console.error('Could not get 2D context');
    return '';
  }
  
  // Draw the region from the renderer canvas
  ctx.drawImage(canvas, x, y, width, height, 0, 0, width, height);
  
  return tempCanvas.toDataURL('image/png');
}

// ============== Polling Utilities ==============

/**
 * Poll a task until completion
 * @param taskId The task ID to poll
 * @param onProgress Callback for progress updates
 * @param pollInterval Interval between polls in ms (default 2000)
 * @param maxPolls Maximum number of polls before giving up (default 300 = 10 min)
 */
export async function pollUntilDone(
  taskId: string,
  onProgress?: (task: ImageTo3DTask) => void,
  pollInterval: number = 2000,
  maxPolls: number = 300
): Promise<ImageTo3DTask | null> {
  let polls = 0;
  
  while (polls < maxPolls) {
    const task = await getTaskStatus(taskId);
    
    if (!task) {
      console.error('[Image-to-3D] Failed to get task status');
      return null;
    }
    
    onProgress?.(task);
    
    if (task.status === 'SUCCEEDED' || task.status === 'FAILED' || task.status === 'CANCELED') {
      return task;
    }
    
    await new Promise(resolve => setTimeout(resolve, pollInterval));
    polls++;
  }
  
  console.error('[Image-to-3D] Polling timeout');
  return null;
}

// ============== Full Workflow ==============

/**
 * Complete workflow: capture viewport, generate 3D, download
 * @param renderer The Three.js renderer to capture from
 * @param description Description of the object to generate
 * @param options Generation options
 * @param onProgress Progress callback
 */
export async function generateFromViewport(
  renderer: { domElement: HTMLCanvasElement },
  description: string,
  options?: ImageTo3DOptions,
  onProgress?: (stage: string, progress: number, task?: ImageTo3DTask) => void
): Promise<{ success: boolean; localPath?: string; error?: string }> {
  try {
    // Step 1: Capture viewport
    onProgress?.('capturing', 0);
    const imageData = captureViewport(renderer);
    
    if (!imageData || imageData.length < 100) {
      return { success: false, error: 'Failed to capture viewport' };
    }
    
    onProgress?.('capturing', 100);
    
    // Step 2: Create task
    onProgress?.('creating', 0);
    const createResult = await createImageTo3DTask(imageData, description, options);
    
    if (!createResult.success || !createResult.taskId) {
      return { success: false, error: createResult.error || 'Failed to create task' };
    }
    
    onProgress?.('creating', 100);
    
    // Step 3: Poll until done
    const task = await pollUntilDone(
      createResult.taskId,
      (t) => onProgress?.('generating', t.progress, t)
    );
    
    if (!task || task.status !== 'SUCCEEDED') {
      return { success: false, error: task?.error || 'Generation failed' };
    }
    
    // Step 4: Download model
    onProgress?.('downloading', 0);
    const downloadResult = await downloadModel(createResult.taskId);
    
    if (!downloadResult.success) {
      return { success: false, error: downloadResult.error || 'Download failed' };
    }
    
    onProgress?.('downloading', 100);
    
    return {
      success: true,
      localPath: downloadResult.localPath,
    };
    
  } catch (error) {
    console.error('[Image-to-3D] Generate from viewport error:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}
