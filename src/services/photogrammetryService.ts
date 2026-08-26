/**
 * Photogrammetry API Service
 * 
 * Frontend service for interacting with the photogrammetry backend.
 * Handles upload, processing, and result retrieval.
 */

import type {
  PhotogrammetryScan,
  PhotogrammetryPhoto,
  ProcessingOptions,
  ProcessingProgress,
  NavigationGraph,
} from '../types/photogrammetry';

const API_BASE = '/api/photogrammetry';

/**
 * Scan metadata returned from API
 */
export interface ScanSummary {
  id: string;
  roomName: string;
  createdAt: string;
  totalPhotos: number;
  status: string;
  propertyId?: string;
}

/**
 * Processing status response
 */
export interface ProcessingStatus {
  scanId: string;
  processing: boolean;
  status: string;
  progress: ProcessingProgress | null;
  result: ProcessingResult | null;
}

/**
 * Result of photogrammetry processing
 */
export interface ProcessingResult {
  success: boolean;
  totalTime: number;
  numRegistered: number;
  numPoints: number;
  numVertices: number;
  numFaces: number;
  numViewpoints: number;
  dimensions: Record<string, number>;
  error?: string;
}

/**
 * Create a new scan
 */
export async function createScan(options: {
  roomName?: string;
  propertyId?: string;
  metadata?: Record<string, unknown>;
}): Promise<{ scanId: string; uploadUrl: string }> {
  const response = await fetch(`${API_BASE}/scans`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to create scan');
  }
  
  return response.json();
}

/**
 * Upload photos to a scan
 */
export async function uploadPhotos(
  scanId: string,
  photos: PhotogrammetryPhoto[],
  imuData?: Record<string, unknown>,
  onProgress?: (percent: number) => void,
): Promise<{ uploaded: number; totalPhotos: number }> {
  const BATCH_SIZE = 50; // Upload 50 photos at a time to avoid rate limits
  let totalUploaded = 0;
  
  // Split photos into batches
  for (let batchStart = 0; batchStart < photos.length; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, photos.length);
    const batchPhotos = photos.slice(batchStart, batchEnd);
    
    const formData = new FormData();
    
    // Add photos for this batch
    for (let i = 0; i < batchPhotos.length; i++) {
      const photo = batchPhotos[i];
      
      // Convert imageData (base64 or blob URL) to blob
      let blob: Blob;
      if (photo.imageData && typeof photo.imageData === 'string') {
        // Handle both base64 and blob URLs
        if (photo.imageData.startsWith('data:') || photo.imageData.startsWith('blob:')) {
          const response = await fetch(photo.imageData);
          blob = await response.blob();
        } else {
          // Assume base64 without data: prefix
          const binary = atob(photo.imageData);
          const bytes = new Uint8Array(binary.length);
          for (let j = 0; j < binary.length; j++) {
            bytes[j] = binary.charCodeAt(j);
          }
          blob = new Blob([bytes], { type: 'image/jpeg' });
        }
      } else {
        console.error('[PhotogrammetryService] Invalid imageData for photo', photo.id, typeof photo.imageData);
        continue;
      }
      
      formData.append('photos', blob, `photo_${batchStart + i}.jpg`);
    }
    
    // Add IMU data only on first batch
    if (batchStart === 0 && imuData) {
      formData.append('imuData', JSON.stringify(imuData));
    }
    
    const response = await fetch(`${API_BASE}/scans/${scanId}/photos`, {
      method: 'POST',
      body: formData,
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to upload photos');
    }
    
    totalUploaded += batchPhotos.length;
    
    if (onProgress) {
      onProgress((totalUploaded / photos.length) * 100);
    }
    
    // Small delay between batches to avoid rate limiting
    if (batchEnd < photos.length) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  
  return { uploaded: totalUploaded, totalPhotos: photos.length };
}

/**
 * Upload scan metadata (IMU data, camera params)
 */
export async function uploadMetadata(
  scanId: string,
  metadata: {
    imuData?: Record<string, unknown>;
    cameraIntrinsics?: {
      fx: number;
      fy: number;
      cx: number;
      cy: number;
    };
    coverageReport?: Record<string, unknown>;
    clusters?: unknown[];
    pathLength?: number;
  },
): Promise<void> {
  const response = await fetch(`${API_BASE}/scans/${scanId}/metadata`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(metadata),
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to upload metadata');
  }
}

/**
 * Start processing a scan
 */
export async function startProcessing(
  scanId: string,
  options?: Partial<ProcessingOptions>,
): Promise<{ statusUrl: string; progressUrl: string }> {
  const response = await fetch(`${API_BASE}/scans/${scanId}/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ options }),
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to start processing');
  }
  
  return response.json();
}

/**
 * Get processing status
 */
export async function getProcessingStatus(scanId: string): Promise<ProcessingStatus> {
  const response = await fetch(`${API_BASE}/scans/${scanId}/status`);
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to get status');
  }
  
  return response.json();
}

/**
 * Subscribe to processing progress via Server-Sent Events
 * Includes automatic reconnection with exponential backoff
 */
export function subscribeToProgress(
  scanId: string,
  onProgress: (progress: ProcessingProgress) => void,
  onComplete: (result: ProcessingResult) => void,
  onError: (error: Error) => void,
): () => void {
  let eventSource: EventSource | null = null;
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let isManualClose = false;
  
  const connect = () => {
    if (isManualClose) return;
    
    eventSource = new EventSource(`${API_BASE}/scans/${scanId}/progress`);
    
    eventSource.onmessage = (event) => {
      try {
        const progress = JSON.parse(event.data) as ProcessingProgress;
        reconnectAttempts = 0; // Reset reconnect counter on successful message
        onProgress(progress);
        
        if (progress.phase === 'complete') {
          isManualClose = true;
          eventSource?.close();
          // Fetch full result
          getProcessingStatus(scanId)
            .then((status) => {
              if (status.result) {
                onComplete(status.result as unknown as ProcessingResult);
              }
            })
            .catch(onError);
        } else if (progress.phase === 'failed') {
          isManualClose = true;
          eventSource?.close();
          onError(new Error(progress.message || 'Processing failed'));
        }
      } catch (e) {
        console.error('Error parsing progress:', e);
      }
    };
    
    eventSource.onerror = (_error) => {
      eventSource?.close();
      
      if (isManualClose) return;
      
      // Check if processing is still ongoing by polling status
      getProcessingStatus(scanId)
        .then((status) => {
          if (status.processing && reconnectAttempts < 10) {
            // Still processing, attempt reconnect with exponential backoff
            reconnectAttempts++;
            const delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 30000);
            console.log(`SSE connection lost. Reconnecting in ${delay}ms (attempt ${reconnectAttempts}/10)...`);
            
            reconnectTimer = setTimeout(() => {
              connect();
            }, delay);
          } else if (!status.processing) {
            // Processing finished while disconnected
            if (status.result) {
              onComplete(status.result as unknown as ProcessingResult);
            } else {
              onError(new Error('Processing completed but no result available'));
            }
          } else {
            // Too many reconnect attempts
            onError(new Error('Connection lost - too many reconnect attempts'));
          }
        })
        .catch((err) => {
          console.error('Failed to check processing status:', err);
          onError(new Error('Connection lost and unable to verify processing status'));
        });
    };
  };
  
  // Start initial connection
  connect();
  
  // Return cleanup function
  return () => {
    isManualClose = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
    }
    eventSource?.close();
  };
}

/**
 * Get mesh URL
 */
export function getMeshUrl(scanId: string, format: 'glb' | 'gltf' | 'obj' | 'ply' = 'glb'): string {
  return `${API_BASE}/scans/${scanId}/mesh?format=${format}`;
}

/**
 * Get texture URL
 */
export function getTextureUrl(scanId: string): string {
  return `${API_BASE}/scans/${scanId}/texture`;
}

/**
 * Get navigation graph
 */
export async function getNavigation(scanId: string): Promise<NavigationGraph> {
  const response = await fetch(`${API_BASE}/scans/${scanId}/navigation`);
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to get navigation');
  }
  
  return response.json();
}

/**
 * List all scans
 */
export async function listScans(): Promise<ScanSummary[]> {
  const response = await fetch(`${API_BASE}/scans`);
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to list scans');
  }
  
  const data = await response.json();
  return data.scans;
}

/**
 * Delete a scan
 */
export async function deleteScan(scanId: string): Promise<void> {
  const response = await fetch(`${API_BASE}/scans/${scanId}`, {
    method: 'DELETE',
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to delete scan');
  }
}

/**
 * Cancel processing
 */
export async function cancelProcessing(scanId: string): Promise<void> {
  const response = await fetch(`${API_BASE}/scans/${scanId}/cancel`, {
    method: 'POST',
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to cancel processing');
  }
}

/**
 * Upload a complete scan (photos + metadata) in one call
 */
export async function uploadCompleteScan(
  scan: PhotogrammetryScan,
  options?: {
    roomName?: string;
    propertyId?: string;
    onProgress?: (phase: string, percent: number) => void;
  },
): Promise<string> {
  const { roomName, propertyId, onProgress } = options || {};
  
  // 1. Create scan
  onProgress?.('Creating scan...', 0);
  const { scanId } = await createScan({
    roomName,
    propertyId,
    metadata: {
      capturedAt: scan.createdAt,
      completedAt: scan.updatedAt,
      captureTime: scan.captureTime,
      pathLength: scan.pathLength,
      pipelineVersion: scan.pipelineVersion || 'v1',
      arTracking: scan.arTracking,
    },
  });
  
  // 2. Upload photos
  onProgress?.('Uploading photos...', 10);
  
  // Build IMU data mapping
  const imuData: Record<string, unknown> = {};
  // Build AR poses for v2 pipeline
  const arPoses: Record<string, unknown>[] = [];
  
  for (const photo of scan.photos) {
    imuData[photo.id] = {
      position: photo.estimatedPosition,
      rotation: photo.estimatedRotation,
      imuData: photo.imuData,
    };
    
    // Collect AR pose data if available (Pipeline v2)
    if (photo.arPose) {
      arPoses.push({
        photoId: photo.id,
        ...photo.arPose,
      });
    }
  }
  
  await uploadPhotos(
    scanId,
    scan.photos,
    imuData,
    (percent) => onProgress?.('Uploading photos...', 10 + percent * 0.4),
  );
  
  // 3. Upload additional metadata
  onProgress?.('Uploading metadata...', 50);
  const firstPhoto = scan.photos[0];
  const intrinsics = firstPhoto?.cameraIntrinsics;
  await uploadMetadata(scanId, {
    imuData,
    cameraIntrinsics: intrinsics ? {
      fx: (intrinsics as { fx?: number }).fx ?? 1.2 * 1920,
      fy: (intrinsics as { fy?: number }).fy ?? 1.2 * 1920,
      cx: (intrinsics as { cx?: number }).cx ?? 1920 / 2,
      cy: (intrinsics as { cy?: number }).cy ?? 1080 / 2,
    } : {
      fx: 1.2 * 1920,
      fy: 1.2 * 1920,
      cx: 1920 / 2,
      cy: 1080 / 2,
    },
    clusters: scan.clusters,
    pathLength: scan.pathLength,
    pipelineVersion: scan.pipelineVersion || 'v1',
    arPoses: arPoses.length > 0 ? arPoses : undefined,
    arTracking: scan.arTracking,
  });
  
  onProgress?.('Ready for processing', 60);
  
  return scanId;
}

/**
 * Process a scan and wait for completion
 */
export async function processAndWait(
  scanId: string,
  options?: {
    processingOptions?: Partial<ProcessingOptions>;
    onProgress?: (progress: ProcessingProgress) => void;
    timeout?: number;
  },
): Promise<ProcessingResult> {
  const { processingOptions, onProgress, timeout = 14400000 } = options || {}; // 4 hours for large scans (433+ images)
  
  // Start processing
  await startProcessing(scanId, processingOptions);
  
  // Wait for completion
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      unsubscribe();
      reject(new Error('Processing timeout'));
    }, timeout);
    
    const unsubscribe = subscribeToProgress(
      scanId,
      (progress) => {
        onProgress?.(progress);
      },
      (result) => {
        clearTimeout(timeoutId);
        resolve(result);
      },
      (error) => {
        clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}

/**
 * Full workflow: upload and process a scan
 */
export async function captureAndProcess(
  scan: PhotogrammetryScan,
  options?: {
    roomName?: string;
    propertyId?: string;
    processingOptions?: Partial<ProcessingOptions>;
    onProgress?: (phase: string, percent: number, message?: string) => void;
  },
): Promise<{ scanId: string; result: ProcessingResult }> {
  const { roomName, propertyId, processingOptions, onProgress } = options || {};
  
  // Upload scan
  const scanId = await uploadCompleteScan(scan, {
    roomName,
    propertyId,
    onProgress: (phase, percent) => onProgress?.(phase, percent),
  });
  
  // Process
  onProgress?.('Processing', 60, 'Starting photogrammetry pipeline...');
  
  const result = await processAndWait(scanId, {
    processingOptions,
    onProgress: (progress) => {
      const percent = 60 + (progress.percent / 100) * 40;
      onProgress?.('Processing', percent, progress.message);
    },
  });
  
  onProgress?.('Complete', 100, 'Scan complete!');
  
  return { scanId, result };
}
