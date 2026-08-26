/**
 * Meshy Text-to-3D Service
 * 
 * Client-side functions for generating 3D objects from text prompts
 * using Meshy AI Text-to-3D API
 */

// ============================================================================
// Types
// ============================================================================

export interface TextTo3DPreviewOptions {
  artStyle?: 'realistic' | 'sculpture';
  aiModel?: 'meshy-4' | 'meshy-5' | 'latest';
  targetPolycount?: number;
  topology?: 'quad' | 'triangle';
}

export interface TextTo3DRefineOptions {
  enablePBR?: boolean;
  texturePrompt?: string;
  aiModel?: 'meshy-4' | 'meshy-5' | 'latest';
}

export interface TextTo3DTaskStatus {
  success: boolean;
  jobId: string;
  taskId: string;
  type: 'preview' | 'refine';
  status: 'PENDING' | 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'CANCELED';
  progress: number;
  prompt?: string;
  thumbnailUrl?: string;
  modelUrls?: {
    glb?: string;
    fbx?: string;
    obj?: string;
    mtl?: string;
    usdz?: string;
  };
  textureUrls?: Array<{
    base_color?: string;
    metallic?: string;
    normal?: string;
    roughness?: string;
  }>;
  error?: string;
}

export interface GeneratedObject {
  filename: string;
  url: string;
  thumbnailUrl: string | null;
  createdAt: string;
  fileSize: number;
}

// ============================================================================
// Furniture Presets
// ============================================================================

export const FURNITURE_PRESETS = {
  seating: [
    { name: 'Modern Sofa', prompt: 'modern minimalist three-seat sofa, light gray fabric upholstery, wooden legs, contemporary living room furniture' },
    { name: 'Leather Armchair', prompt: 'classic leather armchair, brown leather, tufted back, comfortable reading chair, mid-century modern style' },
    { name: 'Dining Chair', prompt: 'elegant dining chair, upholstered seat, dark wood frame, simple modern design' },
    { name: 'Office Chair', prompt: 'ergonomic office chair, mesh back, adjustable height, modern workspace furniture, black and chrome' },
    { name: 'Bar Stool', prompt: 'industrial bar stool, metal frame, wooden seat, counter height, rustic modern style' },
    { name: 'Accent Chair', prompt: 'velvet accent chair, deep blue color, gold metal legs, art deco inspired design' },
  ],
  tables: [
    { name: 'Coffee Table', prompt: 'modern coffee table, glass top, black metal frame, rectangular shape, living room furniture' },
    { name: 'Dining Table', prompt: 'large dining table, solid oak wood, natural finish, seats six, farmhouse style' },
    { name: 'Side Table', prompt: 'round side table, marble top, gold metal base, end table, elegant design' },
    { name: 'Desk', prompt: 'modern home office desk, walnut wood top, black metal legs, minimalist style, with cable management' },
    { name: 'Console Table', prompt: 'narrow console table, dark wood, two drawers, entryway furniture, transitional style' },
    { name: 'Nightstand', prompt: 'bedroom nightstand, white finish, two drawers, modern minimalist, bedside table' },
  ],
  storage: [
    { name: 'Bookshelf', prompt: 'tall bookshelf, 5 shelves, solid wood, natural oak finish, open back design' },
    { name: 'TV Stand', prompt: 'modern TV stand, media console, white with wood accents, cable management, storage doors' },
    { name: 'Dresser', prompt: 'bedroom dresser, 6 drawers, gray finish, modern design, brushed nickel handles' },
    { name: 'Wardrobe', prompt: 'tall wardrobe cabinet, double doors, internal shelves and hanging rail, white finish' },
    { name: 'Kitchen Cabinet', prompt: 'modular kitchen upper cabinet, white shaker style doors, interior shelving' },
    { name: 'Floating Shelf', prompt: 'wall mounted floating shelf, solid walnut wood, hidden brackets, minimalist design' },
  ],
  lighting: [
    { name: 'Floor Lamp', prompt: 'arc floor lamp, brushed brass finish, white fabric shade, modern living room lighting' },
    { name: 'Table Lamp', prompt: 'ceramic table lamp, white base with texture, cream linen shade, bedside lamp' },
    { name: 'Pendant Light', prompt: 'hanging pendant light, glass globe shade, brass mounting, modern kitchen lighting' },
    { name: 'Chandelier', prompt: 'modern chandelier, 5 arms, black metal frame, exposed bulbs, dining room lighting' },
    { name: 'Wall Sconce', prompt: 'wall mounted sconce light, brass finish, frosted glass shade, hallway lighting' },
    { name: 'Desk Lamp', prompt: 'adjustable desk lamp, matte black, LED, articulating arm, task lighting' },
  ],
  decor: [
    { name: 'Indoor Plant', prompt: 'large monstera plant in ceramic pot, decorative indoor plant, white planter' },
    { name: 'Floor Vase', prompt: 'tall floor vase, matte black ceramic, modern minimalist, decorative vessel' },
    { name: 'Wall Mirror', prompt: 'round wall mirror, thin brass frame, 30 inch diameter, decorative mirror' },
    { name: 'Area Rug', prompt: 'rectangular area rug, geometric pattern, neutral tones, living room rug, plush pile' },
    { name: 'Throw Pillow', prompt: 'decorative throw pillow, velvet texture, mustard yellow, square shape' },
    { name: 'Wall Art', prompt: 'abstract canvas wall art, framed, blue and gold colors, large rectangular painting' },
  ],
  kitchen: [
    { name: 'Kitchen Island', prompt: 'kitchen island with butcher block top, white base cabinet, storage shelves, seating for two' },
    { name: 'Bar Cart', prompt: 'rolling bar cart, gold metal frame, two glass shelves, art deco style' },
    { name: 'Wine Rack', prompt: 'wall mounted wine rack, dark wood, holds 12 bottles, modern farmhouse style' },
    { name: 'Kitchen Sink', prompt: 'farmhouse apron front kitchen sink, white porcelain, deep basin, single bowl' },
    { name: 'Range Hood', prompt: 'stainless steel range hood, modern design, wall mounted, LED lighting' },
  ],
  bathroom: [
    { name: 'Vanity Cabinet', prompt: 'bathroom vanity cabinet, 36 inch, white shaker doors, marble countertop, undermount sink' },
    { name: 'Bathroom Mirror', prompt: 'bathroom mirror with LED lighting, rectangular, frameless, anti-fog' },
    { name: 'Towel Rack', prompt: 'wall mounted towel rack, brushed nickel, double bar, bathroom accessory' },
    { name: 'Toilet', prompt: 'modern toilet, elongated bowl, white porcelain, one-piece design, comfort height' },
    { name: 'Bathtub', prompt: 'freestanding soaking tub, white acrylic, oval shape, modern minimalist design' },
  ],
};

// ============================================================================
// API Functions
// ============================================================================

/**
 * Create a Text-to-3D preview task (generates untextured mesh)
 */
export async function createPreviewTask(
  prompt: string,
  options: TextTo3DPreviewOptions = {}
): Promise<{ success: boolean; taskId?: string; jobId?: string; error?: string }> {
  console.log('[TextTo3D] Creating preview task:', { prompt, options });
  
  const response = await fetch('/api/meshy/text-to-3d/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      artStyle: options.artStyle ?? 'realistic',
      aiModel: options.aiModel ?? 'latest',
      targetPolycount: options.targetPolycount ?? 30000,
      topology: options.topology ?? 'triangle',
    }),
  });
  
  return response.json();
}

/**
 * Create a Text-to-3D refine task (adds textures to preview)
 */
export async function createRefineTask(
  previewTaskId: string,
  options: TextTo3DRefineOptions = {}
): Promise<{ success: boolean; taskId?: string; jobId?: string; error?: string }> {
  console.log('[TextTo3D] Creating refine task:', { previewTaskId, options });
  
  const response = await fetch('/api/meshy/text-to-3d/refine', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      previewTaskId,
      enablePBR: options.enablePBR ?? true,
      texturePrompt: options.texturePrompt,
      aiModel: options.aiModel ?? 'latest',
    }),
  });
  
  return response.json();
}

/**
 * Get status of a Text-to-3D task
 */
export async function getTaskStatus(jobId: string): Promise<TextTo3DTaskStatus> {
  const response = await fetch(`/api/meshy/text-to-3d/status/${jobId}`);
  return response.json();
}

/**
 * Download the generated model
 */
export async function downloadModel(
  jobId: string,
  format: 'glb' | 'fbx' | 'obj' | 'usdz' = 'glb'
): Promise<{ success: boolean; localUrl?: string; thumbnailUrl?: string; error?: string }> {
  const response = await fetch(`/api/meshy/text-to-3d/download/${jobId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ format }),
  });
  
  return response.json();
}

/**
 * Poll for task completion with progress callback
 */
export async function pollUntilDone(
  jobId: string,
  onProgress?: (status: TextTo3DTaskStatus) => void,
  pollInterval: number = 3000,
  maxWait: number = 600000 // 10 minutes
): Promise<TextTo3DTaskStatus> {
  const startTime = Date.now();
  
  while (Date.now() - startTime < maxWait) {
    const status = await getTaskStatus(jobId);
    
    onProgress?.(status);
    
    if (status.status === 'SUCCEEDED' || status.status === 'FAILED' || status.status === 'CANCELED') {
      return status;
    }
    
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }
  
  throw new Error('Text-to-3D task timed out');
}

/**
 * Full generation workflow: Preview + Refine + Download
 */
export async function generateObject(
  prompt: string,
  options: {
    previewOptions?: TextTo3DPreviewOptions;
    refineOptions?: TextTo3DRefineOptions;
    onProgress?: (stage: string, progress: number, status?: TextTo3DTaskStatus) => void;
  } = {}
): Promise<{ success: boolean; localUrl?: string; thumbnailUrl?: string; error?: string }> {
  const { previewOptions, refineOptions, onProgress } = options;
  
  try {
    // Stage 1: Create preview task
    onProgress?.('Creating preview...', 5);
    const previewResult = await createPreviewTask(prompt, previewOptions);
    
    if (!previewResult.success || !previewResult.jobId) {
      throw new Error(previewResult.error || 'Failed to create preview task');
    }
    
    // Stage 2: Wait for preview to complete
    onProgress?.('Generating geometry...', 10);
    const previewStatus = await pollUntilDone(previewResult.jobId, (status) => {
      const progress = 10 + (status.progress || 0) * 0.35; // 10-45%
      onProgress?.('Generating geometry...', progress, status);
    });
    
    if (previewStatus.status !== 'SUCCEEDED') {
      throw new Error(previewStatus.error || 'Preview generation failed');
    }
    
    // Stage 3: Create refine task
    onProgress?.('Adding textures...', 50);
    const refineResult = await createRefineTask(previewStatus.taskId, refineOptions);
    
    if (!refineResult.success || !refineResult.jobId) {
      throw new Error(refineResult.error || 'Failed to create refine task');
    }
    
    // Stage 4: Wait for refine to complete
    const refineStatus = await pollUntilDone(refineResult.jobId, (status) => {
      const progress = 50 + (status.progress || 0) * 0.4; // 50-90%
      onProgress?.('Adding textures...', progress, status);
    });
    
    if (refineStatus.status !== 'SUCCEEDED') {
      throw new Error(refineStatus.error || 'Texture generation failed');
    }
    
    // Stage 5: Download the model
    onProgress?.('Downloading model...', 95);
    const downloadResult = await downloadModel(refineResult.jobId, 'glb');
    
    if (!downloadResult.success) {
      throw new Error(downloadResult.error || 'Failed to download model');
    }
    
    onProgress?.('Complete!', 100);
    
    return {
      success: true,
      localUrl: downloadResult.localUrl,
      thumbnailUrl: downloadResult.thumbnailUrl,
    };
    
  } catch (error: any) {
    console.error('[TextTo3D] Generation failed:', error);
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Get list of active tasks
 */
export async function getActiveTasks(): Promise<{
  success: boolean;
  tasks: Array<{ jobId: string; taskId: string; type: string; status: string; prompt?: string }>;
}> {
  const response = await fetch('/api/meshy/text-to-3d/tasks');
  return response.json();
}

/**
 * Get library of generated objects
 */
export async function getObjectLibrary(): Promise<{
  success: boolean;
  objects: GeneratedObject[];
  count: number;
}> {
  const response = await fetch('/api/meshy/text-to-3d/library');
  return response.json();
}

/**
 * Delete an object from the library
 */
export async function deleteFromLibrary(filename: string): Promise<{ success: boolean; error?: string }> {
  const response = await fetch(`/api/meshy/text-to-3d/library/${encodeURIComponent(filename)}`, {
    method: 'DELETE',
  });
  return response.json();
}
