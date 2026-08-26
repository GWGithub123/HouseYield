export interface RoomTourPipelineStage {
  id: string;
  label: string;
  status: 'pending' | 'queued' | 'running' | 'completed' | 'failed';
  systems: string[];
  updatedAt: string | null;
}

export interface RoomTourJob {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: string;
  pipelineId: string;
  pipelineVersion: string;
  primaryOutput: string;
  roomName: string;
  propertyId?: string | null;
  userId?: string | null;
  metadata: Record<string, unknown>;
  capture: {
    videoUploaded: boolean;
    videoPath: string | null;
    metadataPath: string | null;
    originalFilename?: string;
    mimeType?: string;
    size?: number;
    extractedFrameCount?: number;
    selectedKeyframeCount?: number;
  };
  stages: RoomTourPipelineStage[];
  outputs: {
    splatScenePath: string | null;
    viewerPath?: string | null;
    meshPath: string | null;
    tourManifestPath: string | null;
    previewThumbnailPath?: string | null;
    previewStoryboardPath?: string | null;
    executionManifestPath?: string | null;
    modelViewerUrl?: string | null;
  };
  requestedProcessing: {
    queuedAt: string;
    executionPlan: Record<string, unknown>;
    gcpWorkers: Array<Record<string, unknown>>;
    note?: string;
  } | null;
}

export interface RoomTourPipelineSpec {
  pipelineId: string;
  version: string;
  primaryGoal: string;
  primaryOutput: string;
  optionalOutputs: string[];
  systems: Record<string, string[]>;
  stages: Array<{
    id: string;
    label: string;
    systems: string[];
    output: string;
  }>;
  gcpWorkers: Array<{
    id: string;
    purpose: string;
    systems: string[];
  }>;
}

export interface CreateRoomTourJobInput {
  roomName: string;
  propertyId?: string;
  captureMode?: string;
  devicePlatform?: string;
  notes?: string;
}

export interface QueueRoomTourProcessingInput {
  depthRegularizer?: 'metric3d_v2' | 'depth_anything_v2';
  optionalOutputs?: string[];
  roomAwareProcessing?: boolean;
  useArPoses?: boolean;
}