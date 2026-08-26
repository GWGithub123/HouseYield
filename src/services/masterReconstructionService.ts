import type {
  PhotogrammetryPhoto,
  PhotogrammetryScan,
} from '../types/photogrammetry';

const API_BASE = '/api/master-reconstruction';
const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const UPLOAD_BATCH_SIZE = 40;

export interface MasterReconstructionStage {
  id: string;
  label: string;
  status: 'pending' | 'queued' | 'running' | 'completed' | 'failed';
  updatedAt: string | null;
}

export interface MasterReconstructionJob {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: string;
  jobName: string;
  propertyId?: string | null;
  userId?: string | null;
  metadata?: Record<string, unknown>;
  capture?: {
    imageCount?: number;
    rawFrameCount?: number;
    selectedFrameCount?: number;
    rejectedFrameCount?: number;
    imagesDir?: string | null;
  };
  outputs?: Record<string, string | null>;
  stages: MasterReconstructionStage[];
}

export interface MasterJobProgressSummary {
  percent: number;
  completedStages: number;
  totalStages: number;
  currentStage: MasterReconstructionStage | null;
  message: string;
}

interface CaptureAndProcessMasterOptions {
  roomName?: string;
  propertyId?: string;
  userId?: string;
  captureMode?: 'image_sequence' | 'room_tour';
  gaussianBackend?: 'vanilla' | 'ref_gaussian' | 'scaffold_gs';
  refGaussianCommand?: string;
  requireRefGaussian?: boolean;
  scaffoldGsCommand?: string;
  requireScaffoldGs?: boolean;
  scaffoldGsOnly?: boolean;
  onUploadProgress?: (percent: number, message: string) => void;
  onJobUpdate?: (job: MasterReconstructionJob) => void;
  timeout?: number;
  pollInterval?: number;
}

async function parseJsonResponse<T>(response: Response, fallbackError: string): Promise<T> {
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload
      ? String((payload as { error?: string }).error || fallbackError)
      : fallbackError;
    throw new Error(message);
  }

  return payload as T;
}

async function imageDataToBlob(photo: PhotogrammetryPhoto): Promise<Blob> {
  if (!photo.imageData || typeof photo.imageData !== 'string') {
    throw new Error(`invalid_photo_image_data:${photo.id}`);
  }

  if (photo.imageData.startsWith('data:') || photo.imageData.startsWith('blob:')) {
    const response = await fetch(photo.imageData);
    return response.blob();
  }

  const binary = atob(photo.imageData);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: 'image/jpeg' });
}

function buildCaptureMetadata(
  scan: PhotogrammetryScan,
  options: Pick<CaptureAndProcessMasterOptions, 'roomName' | 'propertyId' | 'userId' | 'captureMode' | 'gaussianBackend'>,
) {
  const firstPhoto = scan.photos[0];
  const captureMode = options.captureMode || 'image_sequence';
  const wantsGaussianRoomTour = captureMode === 'room_tour';
  const intrinsics = firstPhoto?.cameraIntrinsics as {
    fx?: number;
    fy?: number;
    cx?: number;
    cy?: number;
  } | undefined;

  return {
    roomName: options.roomName || scan.roomName || 'Master Reconstruction',
    propertyId: options.propertyId || scan.propertyId || null,
    userId: options.userId || null,
    pipelineVersion: 'master_v1',
    captureMode,
    gaussianOnly: wantsGaussianRoomTour,
    ...(options.gaussianBackend ? { preferredGaussianBackend: options.gaussianBackend } : {}),
    captureSource: wantsGaussianRoomTour ? 'mobile_room_tour_scanner' : 'mobile_photogrammetry_scanner',
    primaryOutputIntent: wantsGaussianRoomTour ? 'gaussian_splats' : 'textured_glb_mesh',
    gaussianBranch: wantsGaussianRoomTour ? 'required_room_tour_primary' : 'post_glomap_viewer_sidecar',
    capturedAt: new Date(scan.createdAt).toISOString(),
    completedAt: new Date(scan.updatedAt).toISOString(),
    captureTimeSeconds: scan.captureTime,
    pathLengthMeters: scan.pathLength,
    totalPhotos: scan.photos.length,
    clusters: scan.clusters,
    arTracking: scan.arTracking,
    deviceInfo: scan.deviceInfo,
    cameraIntrinsics: intrinsics ? {
      fx: intrinsics.fx ?? 1.2 * 1920,
      fy: intrinsics.fy ?? 1.2 * 1920,
      cx: intrinsics.cx ?? 1920 / 2,
      cy: intrinsics.cy ?? 1080 / 2,
    } : undefined,
    captureStats: {
      photoCount: scan.photos.length,
      clusterCount: scan.clusters.length,
      pathLengthMeters: scan.pathLength,
      captureTimeSeconds: scan.captureTime,
    },
  };
}

export function deriveMasterJobProgress(job: MasterReconstructionJob): MasterJobProgressSummary {
  const stages = Array.isArray(job.stages) ? job.stages : [];
  const totalStages = stages.length;
  const completedStages = stages.filter((stage) => stage.status === 'completed').length;
  const failedStage = stages.find((stage) => stage.status === 'failed') || null;
  const runningStage = stages.find((stage) => stage.status === 'running') || null;
  const queuedStage = stages.find((stage) => stage.status === 'queued') || null;
  const pendingStage = stages.find((stage) => stage.status === 'pending') || null;
  const currentStage = failedStage || runningStage || queuedStage || pendingStage || stages[stages.length - 1] || null;
  const mirrorStatus = job.metadata && typeof job.metadata.roomScanMirrorStatus === 'string'
    ? job.metadata.roomScanMirrorStatus
    : null;

  let percent = totalStages > 0 ? Math.round((completedStages / totalStages) * 100) : 0;

  if (job.status === 'completed' && mirrorStatus === 'completed') {
    percent = 100;
  } else if (job.status === 'completed') {
    percent = Math.max(percent, 99);
  } else if (failedStage) {
    percent = Math.max(percent, 1);
  } else if (runningStage && totalStages > 0) {
    percent = Math.min(99, Math.round(((completedStages + 0.5) / totalStages) * 100));
  } else if (job.status === 'queued') {
    percent = Math.max(percent, 4);
  } else if (job.status === 'created' || job.status === 'input_uploaded') {
    percent = Math.max(percent, 1);
  }

  let message = 'Waiting for master_v1 to start';
  if (job.status === 'completed' && mirrorStatus === 'completed') {
    message = 'Master v1 complete. Saved Room Scans is being updated.';
  } else if (job.status === 'completed') {
    message = 'Master v1 complete. Finalizing Saved Room Scans assets.';
  } else if (failedStage) {
    message = `Failed during ${failedStage.label}`;
  } else if (runningStage) {
    message = runningStage.label;
  } else if (queuedStage) {
    message = `Queued: ${queuedStage.label}`;
  } else if (currentStage) {
    message = currentStage.label;
  }

  return {
    percent,
    completedStages,
    totalStages,
    currentStage,
    message,
  };
}

export function getMasterRoomScanId(job: MasterReconstructionJob): string {
  const metadata = job.metadata || {};
  const roomScanId = typeof metadata.roomScanId === 'string' ? metadata.roomScanId : null;
  return roomScanId || job.id;
}

export async function createMasterJob(options: {
  jobName?: string;
  propertyId?: string;
  userId?: string;
  captureMode?: string;
  notes?: string;
}): Promise<MasterReconstructionJob> {
  const response = await fetch(`${API_BASE}/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });

  const payload = await parseJsonResponse<{ success: boolean; job: MasterReconstructionJob }>(
    response,
    'Failed to create master reconstruction job',
  );

  return payload.job;
}

export async function uploadMasterImages(
  jobId: string,
  photos: PhotogrammetryPhoto[],
  onProgress?: (percent: number) => void,
): Promise<void> {
  let uploadedCount = 0;

  for (let startIndex = 0; startIndex < photos.length; startIndex += UPLOAD_BATCH_SIZE) {
    const batchPhotos = photos.slice(startIndex, startIndex + UPLOAD_BATCH_SIZE);
    const formData = new FormData();

    for (let batchIndex = 0; batchIndex < batchPhotos.length; batchIndex += 1) {
      const photo = batchPhotos[batchIndex];
      const blob = await imageDataToBlob(photo);
      formData.append('images', blob, `image_${startIndex + batchIndex}.jpg`);
    }

    const response = await fetch(`${API_BASE}/jobs/${jobId}/images`, {
      method: 'POST',
      body: formData,
    });

    await parseJsonResponse(response, 'Failed to upload master reconstruction images');

    uploadedCount += batchPhotos.length;
    onProgress?.((uploadedCount / photos.length) * 100);
  }
}

export async function uploadMasterMetadata(jobId: string, metadata: Record<string, unknown>): Promise<MasterReconstructionJob> {
  const response = await fetch(`${API_BASE}/jobs/${jobId}/metadata`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(metadata),
  });

  const payload = await parseJsonResponse<{ success: boolean; job: MasterReconstructionJob }>(
    response,
    'Failed to upload master reconstruction metadata',
  );

  return payload.job;
}

export async function queueMasterProcessing(jobId: string, options: Record<string, unknown> = {}): Promise<MasterReconstructionJob> {
  const response = await fetch(`${API_BASE}/jobs/${jobId}/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });

  const payload = await parseJsonResponse<{ success: boolean; job: MasterReconstructionJob }>(
    response,
    'Failed to queue master reconstruction job',
  );

  return payload.job;
}

export async function getMasterJob(jobId: string): Promise<MasterReconstructionJob> {
  const response = await fetch(`${API_BASE}/jobs/${jobId}`);
  const payload = await parseJsonResponse<{ success: boolean; job: MasterReconstructionJob }>(
    response,
    'Failed to load master reconstruction job',
  );
  return payload.job;
}

export async function waitForMasterJobCompletion(
  jobId: string,
  options: {
    onJobUpdate?: (job: MasterReconstructionJob) => void;
    timeout?: number;
    pollInterval?: number;
  } = {},
): Promise<MasterReconstructionJob> {
  const startedAt = Date.now();
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const pollInterval = options.pollInterval ?? DEFAULT_POLL_INTERVAL_MS;

  while (Date.now() - startedAt < timeout) {
    const job = await getMasterJob(jobId);
    options.onJobUpdate?.(job);
    const mirrorStatus = job.metadata && typeof job.metadata.roomScanMirrorStatus === 'string'
      ? job.metadata.roomScanMirrorStatus
      : null;

    if (job.status === 'completed' && mirrorStatus === 'completed') {
      return job;
    }

    if (job.status === 'failed') {
      const lastError = job.metadata && typeof job.metadata.lastError === 'string'
        ? job.metadata.lastError
        : null;
      throw new Error(lastError || 'Master reconstruction failed');
    }

    await new Promise((resolve) => window.setTimeout(resolve, pollInterval));
  }

  throw new Error('Master reconstruction timed out');
}

export async function captureAndProcessMasterScan(
  scan: PhotogrammetryScan,
  options: CaptureAndProcessMasterOptions = {},
): Promise<{ jobId: string; job: MasterReconstructionJob }> {
  const captureMode = options.captureMode || 'image_sequence';
  const wantsGaussianRoomTour = captureMode === 'room_tour';

  options.onUploadProgress?.(0, 'Creating master_v1 job...');

  const job = await createMasterJob({
    jobName: options.roomName || scan.roomName || 'Master Reconstruction',
    propertyId: options.propertyId || scan.propertyId,
    userId: options.userId,
    captureMode,
    notes: wantsGaussianRoomTour
      ? 'Submitted from the mobile room-tour photogrammetry scanner.'
      : 'Submitted from the mobile photogrammetry scanner.',
  });

  options.onJobUpdate?.(job);
  options.onUploadProgress?.(8, 'Uploading capture set to master_v1...');

  await uploadMasterImages(job.id, scan.photos, (percent) => {
    options.onUploadProgress?.(8 + percent * 0.72, 'Uploading capture set to master_v1...');
  });

  options.onUploadProgress?.(84, 'Uploading capture metadata...');
  const metadataJob = await uploadMasterMetadata(job.id, buildCaptureMetadata(scan, options));
  options.onJobUpdate?.(metadataJob);

  options.onUploadProgress?.(92, 'Queueing the dedicated master_v1 VM worker...');
  const queuedJob = await queueMasterProcessing(job.id, {
    captureMode,
    source: wantsGaussianRoomTour ? 'mobile_room_tour_scanner' : 'mobile_photogrammetry_scanner',
    submittedFrom: 'photogrammetry_scan_page',
    gaussianOnly: wantsGaussianRoomTour,
    ...(options.gaussianBackend ? { preferredGaussianBackend: options.gaussianBackend } : {}),
    primaryOutputIntent: wantsGaussianRoomTour ? 'gaussian_splats' : 'textured_glb_mesh',
    gaussianBranch: wantsGaussianRoomTour ? 'required_room_tour_primary' : 'post_glomap_viewer_sidecar',
    requireGaussianSplatting: wantsGaussianRoomTour,
    ...(options.refGaussianCommand
      ? {
        refGaussianCommand: options.refGaussianCommand,
        requireRefGaussian: options.requireRefGaussian === true,
      }
      : {}),
    ...(options.scaffoldGsCommand
      ? {
        scaffoldGsCommand: options.scaffoldGsCommand,
        requireScaffoldGs: options.requireScaffoldGs === true,
        scaffoldGsOnly: options.scaffoldGsOnly === true,
      }
      : {}),
  });
  options.onJobUpdate?.(queuedJob);

  options.onUploadProgress?.(100, 'Capture uploaded. Waiting for master_v1 to finish on the VM...');

  const completedJob = await waitForMasterJobCompletion(job.id, {
    onJobUpdate: options.onJobUpdate,
    timeout: options.timeout,
    pollInterval: options.pollInterval,
  });

  return {
    jobId: job.id,
    job: completedJob,
  };
}