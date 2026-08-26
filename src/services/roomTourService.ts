import {
  CreateRoomTourJobInput,
  QueueRoomTourProcessingInput,
  RoomTourJob,
  RoomTourPipelineSpec,
} from '../types/roomTour';
import { getMobileScanAuthHeaders, getScannerApiBaseUrl } from './mobileScanConfig';

const BACKEND_URL = getScannerApiBaseUrl();
const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB per chunk
const RETRYABLE_NETWORK_PATTERNS = [
  /load failed/i,
  /failed to fetch/i,
  /networkerror/i,
  /network connection was lost/i,
];

function withMobileScanHeaders(init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      ...(init.headers || {}),
      ...getMobileScanAuthHeaders(),
    },
  };
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || 'Request failed');
  }

  return payload as T;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.name === 'TypeError' || RETRYABLE_NETWORK_PATTERNS.some((pattern) => pattern.test(error.message));
}

async function recoverUploadedJob(jobId: string): Promise<RoomTourJob | null> {
  try {
    const job = await getRoomTourJob(jobId);
    return job.capture.videoUploaded ? job : null;
  } catch {
    return null;
  }
}

async function retrySafeRoomTourRequest<T>(request: () => Promise<T>, attempts = 2): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      lastError = error;

      if (!isRetryableNetworkError(error) || attempt === attempts - 1) {
        throw error;
      }

      await delay(350 * (attempt + 1));
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Request failed');
}

export async function getRoomTourSystems(): Promise<RoomTourPipelineSpec> {
  const response = await fetch(`${BACKEND_URL}/api/room-tours/systems`, withMobileScanHeaders());
  const payload = await parseJsonResponse<{ success: true; pipeline: RoomTourPipelineSpec }>(response);
  return payload.pipeline;
}

export async function listRoomTourJobs(): Promise<RoomTourJob[]> {
  const response = await fetch(`${BACKEND_URL}/api/room-tours/jobs`, withMobileScanHeaders());
  const payload = await parseJsonResponse<{ success: true; jobs: RoomTourJob[] }>(response);
  return payload.jobs;
}

export async function getRoomTourJob(jobId: string): Promise<RoomTourJob> {
  const response = await fetch(`${BACKEND_URL}/api/room-tours/jobs/${jobId}`, withMobileScanHeaders());
  const payload = await parseJsonResponse<{ success: true; job: RoomTourJob }>(response);
  return payload.job;
}

export async function createRoomTourJob(input: CreateRoomTourJobInput): Promise<RoomTourJob> {
  const response = await fetch(`${BACKEND_URL}/api/room-tours/jobs`, withMobileScanHeaders({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }));

  const payload = await parseJsonResponse<{ success: true; job: RoomTourJob }>(response);
  return payload.job;
}

export async function uploadRoomTourVideo(
  jobId: string,
  file: File,
  onProgress?: (percent: number) => void,
): Promise<RoomTourJob> {
  // Small files — single upload (no chunking needed)
  if (file.size <= CHUNK_SIZE) {
    const attemptDirectUpload = async (): Promise<RoomTourJob> => {
      onProgress?.(10);
      const formData = new FormData();
      formData.append('video', file);
      const response = await fetch(`${BACKEND_URL}/api/room-tours/jobs/${jobId}/video`, withMobileScanHeaders({
        method: 'POST',
        body: formData,
      }));
      const payload = await parseJsonResponse<{ success: true; job: RoomTourJob }>(response);
      onProgress?.(100);
      return payload.job;
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await attemptDirectUpload();
      } catch (error) {
        const recoveredJob = await recoverUploadedJob(jobId);
        if (recoveredJob) {
          onProgress?.(100);
          return recoveredJob;
        }

        if (!isRetryableNetworkError(error) || attempt === 1) {
          throw error;
        }

        await delay(350 * (attempt + 1));
      }
    }
  }

  // Large files — chunked upload
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  let lastJob: RoomTourJob | null = null;

  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const chunk = file.slice(start, end);

    const formData = new FormData();
    formData.append('chunk', chunk, file.name);
    formData.append('chunkIndex', String(i));
    formData.append('totalChunks', String(totalChunks));
    formData.append('mimeType', file.type || 'video/mp4');
    formData.append('fileName', file.name);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(`${BACKEND_URL}/api/room-tours/jobs/${jobId}/video/chunk`, withMobileScanHeaders({
          method: 'POST',
          body: formData,
        }));

        const payload = await parseJsonResponse<{ success: true; job?: RoomTourJob; chunkIndex?: number }>(response);

        if (payload.job) {
          lastJob = payload.job;
        }

        onProgress?.(Math.round(((i + 1) / totalChunks) * 100));
        break;
      } catch (error) {
        const recoveredJob = await recoverUploadedJob(jobId);
        if (recoveredJob) {
          onProgress?.(100);
          return recoveredJob;
        }

        if (!isRetryableNetworkError(error) || attempt === 1) {
          throw error;
        }

        await delay(350 * (attempt + 1));
      }
    }
  }

  if (!lastJob) {
    const recoveredJob = await recoverUploadedJob(jobId);
    if (recoveredJob) {
      onProgress?.(100);
      return recoveredJob;
    }

    throw new Error('Upload completed but no job returned from server.');
  }

  return lastJob;
}

export async function attachRoomTourMetadata(jobId: string, metadata: Record<string, unknown>): Promise<RoomTourJob> {
  return retrySafeRoomTourRequest(async () => {
    const response = await fetch(`${BACKEND_URL}/api/room-tours/jobs/${jobId}/metadata`, withMobileScanHeaders({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(metadata),
    }));

    const payload = await parseJsonResponse<{ success: true; job: RoomTourJob }>(response);
    return payload.job;
  });
}

export async function queueRoomTourProcessing(jobId: string, input: QueueRoomTourProcessingInput): Promise<RoomTourJob> {
  return retrySafeRoomTourRequest(async () => {
    const response = await fetch(`${BACKEND_URL}/api/room-tours/jobs/${jobId}/process`, withMobileScanHeaders({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }));

    const payload = await parseJsonResponse<{ success: true; job: RoomTourJob }>(response);
    return payload.job;
  });
}