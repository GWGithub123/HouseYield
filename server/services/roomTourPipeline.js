import crypto from 'crypto';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import sharp from 'sharp';
import { spawn } from 'child_process';
import { getRoomTourGcpWorker } from './roomTourGcpWorker.js';

const ROOM_TOUR_DATA_DIR = process.env.ROOM_TOUR_DATA_DIR || path.join(process.cwd(), 'server', 'data', 'room-tours');
const ROOM_TOUR_PIPELINE_VERSION = 'room-tour-v1';
const ROOM_TOUR_EXECUTION_MODE = process.env.ROOM_TOUR_EXECUTION_MODE || 'room_tour_native_v1';
const MAX_KEYFRAMES = parseInt(process.env.ROOM_TOUR_MAX_KEYFRAMES || '48', 10);
const MIN_KEYFRAMES = parseInt(process.env.ROOM_TOUR_MIN_KEYFRAMES || '12', 10);
const FRAME_EXTRACTION_FPS = process.env.ROOM_TOUR_FRAME_EXTRACTION_FPS || '1';
const activeRuns = new Map();
const ROOM_TOUR_REMOTE_STAGE_IDS = [
  'pose_bootstrap',
  'learned_geometry',
  'depth_regularization',
  'global_fusion',
  'splat_training',
  'tour_packaging',
];

const ROOM_TOUR_PIPELINE_SPEC = {
  pipelineId: 'video-room-tour',
  version: ROOM_TOUR_PIPELINE_VERSION,
  primaryGoal: 'visual_accuracy',
  primaryOutput: 'gaussian_splats',
  optionalOutputs: ['mesh', 'glb', 'tour_manifest'],
  implementationMode: ROOM_TOUR_EXECUTION_MODE,
  systems: {
    intake: ['express', 'multer'],
    preprocessing: ['ffmpeg', 'sharp'],
    poseBootstrap: ['arkit_or_arcore_poses', 'hloc', 'lightglue', 'pycolmap'],
    learnedGeometry: ['mast3r'],
    depthRegularization: ['metric3d_v2', 'depth_anything_v2_fallback'],
    globalFusion: ['pycolmap', 'open3d'],
    finalRepresentation: ['gsplat'],
    packaging: ['room_tour_manifest_builder', 'artifact_server'],
  },
  stages: [
    {
      id: 'ingest',
      label: 'Ingest Video',
      systems: ['express', 'multer'],
      output: 'raw video plus metadata',
    },
    {
      id: 'preprocess',
      label: 'Extract and Filter Keyframes',
      systems: ['ffmpeg', 'sharp'],
      output: 'deduplicated walkthrough keyframes',
    },
    {
      id: 'pose_bootstrap',
      label: 'Bootstrap Camera Poses',
      systems: ['arkit_or_arcore_poses', 'hloc', 'lightglue', 'pycolmap'],
      output: 'initial room-tour camera graph',
    },
    {
      id: 'learned_geometry',
      label: 'Run MASt3R Geometry',
      systems: ['mast3r'],
      output: 'pairwise pointmaps and robust correspondences',
    },
    {
      id: 'depth_regularization',
      label: 'Apply Depth Priors',
      systems: ['metric3d_v2', 'depth_anything_v2_fallback'],
      output: 'confidence-weighted depth priors',
    },
    {
      id: 'global_fusion',
      label: 'Fuse Global Scene',
      systems: ['pycolmap', 'open3d'],
      output: 'globally consistent scene initialization',
    },
    {
      id: 'splat_training',
      label: 'Train Gaussian Splats',
      systems: ['gsplat'],
      output: 'streamable splat scene',
    },
    {
      id: 'tour_packaging',
      label: 'Package Separate Tour Assets',
      systems: ['room_tour_manifest_builder', 'artifact_server'],
      output: 'tour manifest, preview assets, separate viewer path',
    },
  ],
  gcpWorkers: [
    {
      id: 'preprocess-worker',
      purpose: 'frame extraction and filtering',
      systems: ['ffmpeg', 'sharp'],
    },
    {
      id: 'geometry-worker',
      purpose: 'poses, MASt3R geometry, depth priors, and global fusion',
      systems: ['mast3r', 'metric3d_v2', 'pycolmap', 'open3d'],
    },
    {
      id: 'splat-worker',
      purpose: 'gsplat training and export',
      systems: ['gsplat'],
    },
  ],
};

function ensureRoomTourDataDirSync() {
  if (!fs.existsSync(ROOM_TOUR_DATA_DIR)) {
    fs.mkdirSync(ROOM_TOUR_DATA_DIR, { recursive: true });
  }
}

async function ensureRoomTourDataDir() {
  await fsPromises.mkdir(ROOM_TOUR_DATA_DIR, { recursive: true });
}

function getJobDir(jobId) {
  return path.join(ROOM_TOUR_DATA_DIR, jobId);
}

function getJobManifestPath(jobId) {
  return path.join(getJobDir(jobId), 'job.json');
}

function getJobOutputsDir(jobId) {
  return path.join(getJobDir(jobId), 'outputs');
}

function getJobNativeOutputDir(jobId) {
  return path.join(getJobDir(jobId), 'native-output');
}

function getArtifactUrl(jobId, relativePath) {
  return `/api/room-tours/jobs/${jobId}/artifacts/${relativePath.replace(/\\/g, '/')}`;
}

function buildStageState() {
  return ROOM_TOUR_PIPELINE_SPEC.stages.map((stage) => ({
    id: stage.id,
    label: stage.label,
    status: 'pending',
    systems: stage.systems,
    updatedAt: null,
  }));
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeError(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

async function saveJob(job) {
  await ensureRoomTourDataDir();
  await fsPromises.mkdir(getJobDir(job.id), { recursive: true });
  await fsPromises.writeFile(getJobManifestPath(job.id), JSON.stringify(job, null, 2));
  return job;
}

function updateStage(job, stageId, nextStatus) {
  const updatedAt = nowIso();
  job.stages = job.stages.map((stage) => (
    stage.id === stageId
      ? { ...stage, status: nextStatus, updatedAt }
      : stage
  ));
  return job;
}

function markStages(job, stageIds, nextStatus) {
  const updatedAt = nowIso();
  const stageSet = new Set(stageIds);
  job.stages = job.stages.map((stage) => (
    stageSet.has(stage.id)
      ? { ...stage, status: nextStatus, updatedAt }
      : stage
  ));
  return job;
}

function applyRemoteStageSummary(job, stageSummary = {}) {
  const summarizedStatuses = new Map(
    Object.entries(stageSummary)
      .filter(([, summary]) => summary && typeof summary.status === 'string')
      .map(([stageId, summary]) => [stageId, summary.status]),
  );

  if (summarizedStatuses.size === 0) {
    return job;
  }

  const updatedAt = nowIso();
  job.stages = job.stages.map((stage) => {
    const nextStatus = summarizedStatuses.get(stage.id);
    return nextStatus
      ? { ...stage, status: nextStatus, updatedAt }
      : stage;
  });
  job.metadata = {
    ...job.metadata,
    remoteStageSummary: {
      ...(job.metadata?.remoteStageSummary || {}),
      ...stageSummary,
    },
  };

  return job;
}

async function readJob(jobId) {
  const jobPath = getJobManifestPath(jobId);
  return JSON.parse(await fsPromises.readFile(jobPath, 'utf8'));
}

async function mutateJob(jobId, mutate) {
  const job = await readJob(jobId);
  const nextJob = await mutate(job);
  return saveJob(nextJob);
}

async function setJobFailure(jobId, error, failedStageId) {
  return mutateJob(jobId, async (job) => {
    job.updatedAt = nowIso();
    job.status = 'failed';
    job.metadata = {
      ...job.metadata,
      lastError: normalizeError(error),
      failedAt: nowIso(),
    };

    if (failedStageId) {
      job = updateStage(job, failedStageId, 'failed');
    }

    return job;
  });
}

async function refreshNativeOutputs(job) {
  const nativeOutputDir = getJobNativeOutputDir(job.id);
  const outputsDir = getJobOutputsDir(job.id);
  const discoveredOutputs = {
    ...job.outputs,
  };

  const candidates = [
    { key: 'splatScenePath', relativePath: 'scene.splat' },
    { key: 'splatScenePath', relativePath: 'scene.ksplat' },
    { key: 'viewerPath', relativePath: 'viewer/index.html' },
    { key: 'meshPath', relativePath: 'model.glb' },
    { key: 'meshPath', relativePath: 'model.gltf' },
    { key: 'tourManifestPath', relativePath: 'tour-manifest.json', baseDir: outputsDir },
    { key: 'previewThumbnailPath', relativePath: 'preview/thumbnail.jpg', baseDir: outputsDir },
  ];

  for (const candidate of candidates) {
    const baseDir = candidate.baseDir || nativeOutputDir;
    const absolutePath = path.join(baseDir, candidate.relativePath);
    try {
      await fsPromises.access(absolutePath);
      if (!discoveredOutputs[candidate.key]) {
        const relativeBase = baseDir === outputsDir ? candidate.relativePath : path.join('native-output', candidate.relativePath);
        discoveredOutputs[candidate.key] = getArtifactUrl(job.id, relativeBase);
      }
    } catch {
      // Ignore missing optional artifacts.
    }
  }

  if (!discoveredOutputs.tourManifestPath) {
    const manifestPath = path.join(outputsDir, 'tour-manifest.json');
    try {
      await fsPromises.access(manifestPath);
      discoveredOutputs.tourManifestPath = getArtifactUrl(job.id, 'outputs/tour-manifest.json');
    } catch {
      // Ignore until manifest is written.
    }
  }

  if (!discoveredOutputs.previewThumbnailPath) {
    const previewPath = path.join(outputsDir, 'preview', 'thumbnail.jpg');
    try {
      await fsPromises.access(previewPath);
      discoveredOutputs.previewThumbnailPath = getArtifactUrl(job.id, 'outputs/preview/thumbnail.jpg');
    } catch {
      // Ignore.
    }
  }

  if (!discoveredOutputs.previewStoryboardPath) {
    const storyboardPath = path.join(outputsDir, 'preview', 'storyboard.json');
    try {
      await fsPromises.access(storyboardPath);
      discoveredOutputs.previewStoryboardPath = getArtifactUrl(job.id, 'outputs/preview/storyboard.json');
    } catch {
      // Ignore.
    }
  }

  if (!discoveredOutputs.executionManifestPath) {
    const executionManifestPath = path.join(outputsDir, 'native-execution.json');
    try {
      await fsPromises.access(executionManifestPath);
      discoveredOutputs.executionManifestPath = getArtifactUrl(job.id, 'outputs/native-execution.json');
    } catch {
      // Ignore.
    }
  }

  const hasDeliverable = Boolean(discoveredOutputs.meshPath || discoveredOutputs.viewerPath || discoveredOutputs.splatScenePath);
  discoveredOutputs.modelViewerUrl = hasDeliverable ? `/room-tour-view/${job.id}` : null;

  let nextJob = {
    ...job,
    outputs: discoveredOutputs,
  };

  const remoteStageSummary = nextJob.metadata?.remoteWorkerResult?.stageSummary || nextJob.metadata?.remoteStageSummary;
  nextJob = applyRemoteStageSummary(nextJob, remoteStageSummary);

  if (hasDeliverable && nextJob.status !== 'completed') {
    nextJob.status = 'completed';
    nextJob.metadata = {
      ...nextJob.metadata,
      completedAt: nowIso(),
    };
    if (!remoteStageSummary) {
      nextJob = markStages(nextJob, ROOM_TOUR_REMOTE_STAGE_IDS, 'completed');
    }
  }

  return nextJob;
}

async function loadJob(jobId) {
  const job = await readJob(jobId);
  const refreshed = await refreshNativeOutputs(job);
  if (JSON.stringify(refreshed) !== JSON.stringify(job)) {
    await saveJob(refreshed);
  }
  return refreshed;
}

async function listJobs() {
  await ensureRoomTourDataDir();
  const entries = await fsPromises.readdir(ROOM_TOUR_DATA_DIR, { withFileTypes: true });
  const jobs = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    try {
      jobs.push(await loadJob(entry.name));
    } catch {
      // Ignore incomplete directories.
    }
  }

  return jobs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

async function createRoomTourJob(input = {}) {
  const jobId = `tour_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  const createdAt = nowIso();
  const job = {
    id: jobId,
    createdAt,
    updatedAt: createdAt,
    status: 'created',
    pipelineId: ROOM_TOUR_PIPELINE_SPEC.pipelineId,
    pipelineVersion: ROOM_TOUR_PIPELINE_SPEC.version,
    primaryOutput: ROOM_TOUR_PIPELINE_SPEC.primaryOutput,
    roomName: input.roomName || 'Untitled Tour',
    propertyId: input.propertyId || null,
    userId: input.userId || null,
    metadata: {
      captureMode: input.captureMode || 'video_walkthrough',
      devicePlatform: input.devicePlatform || null,
      notes: input.notes || null,
      executionMode: ROOM_TOUR_EXECUTION_MODE,
    },
    capture: {
      videoUploaded: false,
      videoPath: null,
      metadataPath: null,
      extractedFrameCount: 0,
      selectedKeyframeCount: 0,
    },
    stages: buildStageState(),
    systems: ROOM_TOUR_PIPELINE_SPEC.systems,
    requestedProcessing: null,
    outputs: {
      splatScenePath: null,
      viewerPath: null,
      meshPath: null,
      tourManifestPath: null,
      previewThumbnailPath: null,
      previewStoryboardPath: null,
      executionManifestPath: null,
      modelViewerUrl: null,
    },
  };

  return saveJob(job);
}

async function attachVideoToJob(jobId, file) {
  let job = await readJob(jobId);
  job.updatedAt = nowIso();
  job.status = 'video_uploaded';
  job.capture.videoUploaded = true;
  job.capture.videoPath = file.path;
  job.capture.originalFilename = file.originalname;
  job.capture.mimeType = file.mimetype;
  job.capture.size = file.size;
  job = updateStage(job, 'ingest', 'completed');
  return saveJob(job);
}

async function attachMetadataToJob(jobId, metadata) {
  const job = await readJob(jobId);
  const metadataPath = path.join(getJobDir(jobId), 'raw', 'capture-metadata.json');

  await fsPromises.mkdir(path.dirname(metadataPath), { recursive: true });
  await fsPromises.writeFile(metadataPath, JSON.stringify(metadata, null, 2));

  job.updatedAt = nowIso();
  job.capture.metadataPath = metadataPath;
  job.metadata = {
    ...job.metadata,
    ...metadata,
  };

  return saveJob(job);
}

function buildExecutionPlan(options = {}) {
  return {
    primaryGeometryBackbone: 'mast3r',
    activeExecutionMode: ROOM_TOUR_EXECUTION_MODE,
    depthRegularizer: options.depthRegularizer || 'metric3d_v2',
    finalRepresentation: 'gsplat',
    optionalOutputs: options.optionalOutputs || ['tour_manifest'],
    roomAwareProcessing: options.roomAwareProcessing !== false,
    useArPoses: options.useArPoses !== false,
    maxKeyframes: MAX_KEYFRAMES,
    workerOutputDirectory: 'native-output',
  };
}

async function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(stderr || stdout || `${command} exited with code ${code}`));
    });
  });
}

async function ensureFfmpegAvailable() {
  await runCommand('ffmpeg', ['-version']);
}

async function pathExists(candidatePath) {
  try {
    await fsPromises.access(candidatePath);
    return true;
  } catch {
    return false;
  }
}

async function copyDirectory(sourceDir, destinationDir) {
  await fsPromises.mkdir(destinationDir, { recursive: true });
  const entries = await fsPromises.readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, destinationPath);
      continue;
    }

    await fsPromises.copyFile(sourcePath, destinationPath);
  }
}

function averageAbsoluteDifference(left, right) {
  let total = 0;

  for (let index = 0; index < left.length; index += 1) {
    total += Math.abs(left[index] - right[index]);
  }

  return total / left.length;
}

function calculateEdgeScore(sample) {
  const side = Math.round(Math.sqrt(sample.length));
  let total = 0;
  let comparisons = 0;

  for (let y = 0; y < side - 1; y += 1) {
    for (let x = 0; x < side - 1; x += 1) {
      const index = (y * side) + x;
      total += Math.abs(sample[index] - sample[index + 1]);
      total += Math.abs(sample[index] - sample[index + side]);
      comparisons += 2;
    }
  }

  return comparisons > 0 ? total / comparisons : 0;
}

async function analyzeFrame(framePath) {
  const { data } = await sharp(framePath)
    .grayscale()
    .resize(64, 64, { fit: 'cover' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  return {
    sample: data,
    edgeScore: calculateEdgeScore(data),
  };
}

function fillFrameSelection(framePaths, selectedFrames) {
  if (selectedFrames.length >= MIN_KEYFRAMES || framePaths.length <= selectedFrames.length) {
    return selectedFrames;
  }

  const selectedSet = new Set(selectedFrames.map((entry) => entry.path));
  const nextSelection = [...selectedFrames];

  while (nextSelection.length < Math.min(MIN_KEYFRAMES, framePaths.length)) {
    const ratio = nextSelection.length / Math.max(MIN_KEYFRAMES - 1, 1);
    const index = Math.min(framePaths.length - 1, Math.round(ratio * (framePaths.length - 1)));
    const candidate = framePaths[index];

    if (!selectedSet.has(candidate)) {
      nextSelection.push({ path: candidate, reason: 'minimum_coverage' });
      selectedSet.add(candidate);
      continue;
    }

    const fallback = framePaths.find((framePath) => !selectedSet.has(framePath));
    if (!fallback) {
      break;
    }

    nextSelection.push({ path: fallback, reason: 'minimum_coverage' });
    selectedSet.add(fallback);
  }

  return nextSelection.sort((left, right) => left.path.localeCompare(right.path));
}

async function extractKeyframes(job) {
  await ensureFfmpegAvailable();

  const preprocessDir = path.join(getJobDir(job.id), 'preprocess');
  const extractedDir = path.join(preprocessDir, 'frames-extracted');
  const keyframeDir = path.join(preprocessDir, 'keyframes');
  const manifestPath = path.join(preprocessDir, 'manifest.json');

  await fsPromises.rm(extractedDir, { recursive: true, force: true });
  await fsPromises.rm(keyframeDir, { recursive: true, force: true });
  await fsPromises.mkdir(extractedDir, { recursive: true });
  await fsPromises.mkdir(keyframeDir, { recursive: true });

  const outputPattern = path.join(extractedDir, 'frame_%05d.jpg');
  await runCommand('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    job.capture.videoPath,
    '-vf',
    `fps=${FRAME_EXTRACTION_FPS},scale=-2:1080`,
    '-q:v',
    '2',
    outputPattern,
  ]);

  const extractedFrames = (await fsPromises.readdir(extractedDir))
    .filter((entry) => entry.toLowerCase().endsWith('.jpg'))
    .sort()
    .map((entry) => path.join(extractedDir, entry));

  if (extractedFrames.length === 0) {
    throw new Error('No frames were extracted from the uploaded video.');
  }

  const selectedFrames = [];
  let previousSample = null;
  let lastAcceptedIndex = -99;

  for (let index = 0; index < extractedFrames.length; index += 1) {
    const framePath = extractedFrames[index];
    const analysis = await analyzeFrame(framePath);
    const differenceScore = previousSample
      ? averageAbsoluteDifference(analysis.sample, previousSample)
      : Number.POSITIVE_INFINITY;
    const keepForCoverage = selectedFrames.length === 0 || (index - lastAcceptedIndex) >= 2;
    const keepForMotion = differenceScore >= 10;
    const keepForDetail = analysis.edgeScore >= 4;

    if ((keepForMotion || keepForCoverage || keepForDetail) && selectedFrames.length < MAX_KEYFRAMES) {
      selectedFrames.push({
        path: framePath,
        reason: keepForMotion ? 'motion_delta' : (keepForDetail ? 'detail' : 'coverage'),
        edgeScore: Number(analysis.edgeScore.toFixed(2)),
        differenceScore: Number.isFinite(differenceScore) ? Number(differenceScore.toFixed(2)) : null,
      });
      previousSample = analysis.sample;
      lastAcceptedIndex = index;
    }
  }

  const finalizedSelection = fillFrameSelection(extractedFrames, selectedFrames).slice(0, MAX_KEYFRAMES);
  const copiedFrames = [];

  for (let index = 0; index < finalizedSelection.length; index += 1) {
    const frame = finalizedSelection[index];
    const filename = `keyframe_${String(index + 1).padStart(4, '0')}.jpg`;
    const destination = path.join(keyframeDir, filename);
    await fsPromises.copyFile(frame.path, destination);
    copiedFrames.push(destination);
  }

  const manifest = {
    createdAt: nowIso(),
    extractionFps: FRAME_EXTRACTION_FPS,
    extractedFrameCount: extractedFrames.length,
    selectedKeyframeCount: copiedFrames.length,
    selectedFrames: finalizedSelection.map((entry, index) => ({
      source: path.basename(entry.path),
      output: path.basename(copiedFrames[index]),
      reason: entry.reason,
      edgeScore: entry.edgeScore ?? null,
      differenceScore: entry.differenceScore ?? null,
    })),
  };

  await fsPromises.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  return {
    manifest,
    manifestPath,
    keyframeDir,
    framePaths: copiedFrames,
  };
}

async function writePreviewAssets(job, extractionResult) {
  const outputsDir = getJobOutputsDir(job.id);
  const previewDir = path.join(outputsDir, 'preview');
  await fsPromises.mkdir(previewDir, { recursive: true });

  const firstFrame = extractionResult.framePaths[0];
  const thumbnailPath = path.join(previewDir, 'thumbnail.jpg');
  await sharp(firstFrame)
    .resize(960, 540, { fit: 'cover' })
    .jpeg({ quality: 82 })
    .toFile(thumbnailPath);

  const storyboardPath = path.join(previewDir, 'storyboard.json');
  const storyboard = {
    createdAt: nowIso(),
    roomName: job.roomName,
    frames: extractionResult.framePaths.map((framePath, index) => ({
      index,
      filename: path.basename(framePath),
      imageUrl: getArtifactUrl(job.id, path.join('preprocess', 'keyframes', path.basename(framePath))),
    })),
  };
  await fsPromises.writeFile(storyboardPath, JSON.stringify(storyboard, null, 2));

  return {
    thumbnailPath,
    storyboardPath,
  };
}

async function writeNativeExecutionContract(job, extractionResult) {
  const outputsDir = getJobOutputsDir(job.id);
  const nativeOutputDir = getJobNativeOutputDir(job.id);
  await fsPromises.mkdir(outputsDir, { recursive: true });
  await fsPromises.mkdir(nativeOutputDir, { recursive: true });

  const executionManifest = {
    jobId: job.id,
    createdAt: nowIso(),
    pipeline: {
      id: ROOM_TOUR_PIPELINE_SPEC.pipelineId,
      version: ROOM_TOUR_PIPELINE_SPEC.version,
      executionMode: ROOM_TOUR_EXECUTION_MODE,
    },
    input: {
      roomName: job.roomName,
      propertyId: job.propertyId,
      captureVideoPath: job.capture.videoPath,
      captureMetadataPath: job.capture.metadataPath,
      keyframeDirectory: path.join(getJobDir(job.id), 'preprocess', 'keyframes'),
      keyframeCount: extractionResult.manifest.selectedKeyframeCount,
      extractedFrameCount: extractionResult.manifest.extractedFrameCount,
      selectedFrames: extractionResult.manifest.selectedFrames,
    },
    requestedProcessing: job.requestedProcessing,
    expectedOutputs: {
      nativeOutputDirectory: nativeOutputDir,
      splatScene: path.join(nativeOutputDir, 'scene.splat'),
      supportedSplatScenes: [
        path.join(nativeOutputDir, 'scene.splat'),
        path.join(nativeOutputDir, 'scene.ksplat'),
      ],
      viewerHtml: path.join(nativeOutputDir, 'viewer', 'index.html'),
      meshGlb: path.join(nativeOutputDir, 'model.glb'),
      packagedManifest: path.join(outputsDir, 'tour-manifest.json'),
    },
    stages: ROOM_TOUR_PIPELINE_SPEC.stages,
  };

  const executionManifestPath = path.join(outputsDir, 'native-execution.json');
  await fsPromises.writeFile(executionManifestPath, JSON.stringify(executionManifest, null, 2));

  return executionManifestPath;
}

async function writeSeparateTourManifest(job, extractionResult) {
  const outputsDir = getJobOutputsDir(job.id);
  const manifestPath = path.join(outputsDir, 'tour-manifest.json');
  const manifest = {
    jobId: job.id,
    roomName: job.roomName,
    propertyId: job.propertyId,
    createdAt: job.createdAt,
    updatedAt: nowIso(),
    status: 'awaiting_native_geometry',
    primaryOutput: job.primaryOutput,
    preview: {
      thumbnailUrl: getArtifactUrl(job.id, 'outputs/preview/thumbnail.jpg'),
      storyboardUrl: getArtifactUrl(job.id, 'outputs/preview/storyboard.json'),
      selectedKeyframeCount: extractionResult.manifest.selectedKeyframeCount,
      extractedFrameCount: extractionResult.manifest.extractedFrameCount,
    },
    artifacts: {
      executionManifestUrl: getArtifactUrl(job.id, 'outputs/native-execution.json'),
      nativeOutputBaseUrl: getArtifactUrl(job.id, 'native-output'),
      keyframeDirectoryUrl: getArtifactUrl(job.id, 'preprocess/keyframes'),
    },
    execution: {
      mode: ROOM_TOUR_EXECUTION_MODE,
      note: 'This room-tour system is fully separate from photogrammetry. Geometry workers should write splat or mesh outputs into native-output/ for packaging and viewing.',
      gcpWorkers: ROOM_TOUR_PIPELINE_SPEC.gcpWorkers,
    },
  };

  await fsPromises.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return manifestPath;
}

async function buildWorkerPackage(job) {
  const packageDir = path.join(getJobDir(job.id), 'worker-package');
  const keyframeSourceDir = path.join(getJobDir(job.id), 'preprocess', 'keyframes');
  const keyframeDestDir = path.join(packageDir, 'keyframes');
  const metadataSourcePath = path.join(getJobDir(job.id), 'raw', 'capture-metadata.json');
  const metadataDestDir = path.join(packageDir, 'raw');
  const executionManifestSourcePath = path.join(getJobOutputsDir(job.id), 'native-execution.json');
  const outputsDestDir = path.join(packageDir, 'outputs');

  await fsPromises.rm(packageDir, { recursive: true, force: true });
  await fsPromises.mkdir(packageDir, { recursive: true });
  await copyDirectory(keyframeSourceDir, keyframeDestDir);
  await fsPromises.mkdir(outputsDestDir, { recursive: true });
  await fsPromises.copyFile(executionManifestSourcePath, path.join(outputsDestDir, 'native-execution.json'));

  if (await pathExists(metadataSourcePath)) {
    await fsPromises.mkdir(metadataDestDir, { recursive: true });
    await fsPromises.copyFile(metadataSourcePath, path.join(metadataDestDir, 'capture-metadata.json'));
  }

  const packageManifest = {
    jobId: job.id,
    roomName: job.roomName,
    propertyId: job.propertyId,
    createdAt: nowIso(),
    keyframeCount: job.capture.selectedKeyframeCount,
    executionMode: ROOM_TOUR_EXECUTION_MODE,
    requestedProcessing: job.requestedProcessing,
  };

  await fsPromises.writeFile(path.join(packageDir, 'package-manifest.json'), JSON.stringify(packageManifest, null, 2));
  return packageDir;
}

async function runRemoteRoomTourWorker(jobId) {
  const worker = getRoomTourGcpWorker();
  if (!worker.enabled) {
    return null;
  }

  const job = await loadJob(jobId);
  const packageDir = await buildWorkerPackage(job);

  await mutateJob(jobId, async (currentJob) => {
    currentJob.updatedAt = nowIso();
    currentJob.status = 'running_remote_geometry';
    currentJob = updateStage(currentJob, 'pose_bootstrap', 'running');
    currentJob = updateStage(currentJob, 'learned_geometry', 'running');
    currentJob = updateStage(currentJob, 'depth_regularization', 'running');
    currentJob = updateStage(currentJob, 'global_fusion', 'running');
    currentJob = updateStage(currentJob, 'splat_training', 'running');
    currentJob.metadata = {
      ...currentJob.metadata,
      remoteWorkerStartedAt: nowIso(),
    };
    return currentJob;
  });

  const result = await worker.processRoomTour(
    packageDir,
    getJobDir(jobId),
    { jobId },
    (message) => {
      console.log(`[RoomTour][${jobId}] ${message}`);
    },
  );

  await mutateJob(jobId, async (currentJob) => {
    currentJob.updatedAt = nowIso();
    currentJob.status = 'completed';
    currentJob.metadata = {
      ...currentJob.metadata,
      remoteWorkerCompletedAt: nowIso(),
      remoteWorkerResult: result,
    };
    currentJob = result.stageSummary
      ? applyRemoteStageSummary(currentJob, result.stageSummary)
      : markStages(currentJob, ROOM_TOUR_REMOTE_STAGE_IDS, 'completed');
    return currentJob;
  });

  return result;
}

async function runRoomTourJob(jobId) {
  let activeStageId = 'preprocess';

  try {
    let job = await mutateJob(jobId, async (currentJob) => {
      currentJob.updatedAt = nowIso();
      currentJob.status = 'preprocessing';
      currentJob = updateStage(currentJob, 'ingest', 'completed');
      currentJob = updateStage(currentJob, 'preprocess', 'running');
      return currentJob;
    });

    const extractionResult = await extractKeyframes(job);
    activeStageId = 'tour_packaging';

    job = await mutateJob(jobId, async (currentJob) => {
      currentJob.updatedAt = nowIso();
      currentJob.status = 'packaging_separate_room_tour';
      currentJob.capture.extractedFrameCount = extractionResult.manifest.extractedFrameCount;
      currentJob.capture.selectedKeyframeCount = extractionResult.manifest.selectedKeyframeCount;
      currentJob.metadata = {
        ...currentJob.metadata,
        preprocessingManifestPath: extractionResult.manifestPath,
        preprocessingManifest: extractionResult.manifest,
      };
      currentJob = updateStage(currentJob, 'preprocess', 'completed');
      currentJob = updateStage(currentJob, 'tour_packaging', 'running');
      currentJob = updateStage(currentJob, 'pose_bootstrap', 'queued');
      currentJob = updateStage(currentJob, 'learned_geometry', 'queued');
      currentJob = updateStage(currentJob, 'depth_regularization', 'queued');
      currentJob = updateStage(currentJob, 'global_fusion', 'queued');
      currentJob = updateStage(currentJob, 'splat_training', 'queued');
      return currentJob;
    });

    await writePreviewAssets(job, extractionResult);
    await writeNativeExecutionContract(job, extractionResult);
    await writeSeparateTourManifest(job, extractionResult);

    await mutateJob(jobId, async (currentJob) => {
      currentJob.updatedAt = nowIso();
      currentJob.status = 'awaiting_native_geometry';
      currentJob.outputs.previewThumbnailPath = getArtifactUrl(jobId, 'outputs/preview/thumbnail.jpg');
      currentJob.outputs.previewStoryboardPath = getArtifactUrl(jobId, 'outputs/preview/storyboard.json');
      currentJob.outputs.executionManifestPath = getArtifactUrl(jobId, 'outputs/native-execution.json');
      currentJob.outputs.tourManifestPath = getArtifactUrl(jobId, 'outputs/tour-manifest.json');
      currentJob.metadata = {
        ...currentJob.metadata,
        completedAt: null,
        packagingCompletedAt: nowIso(),
        separateSystemNote: 'Room-tour pipeline remains completely separate from photogrammetry. Native geometry workers should populate native-output/ to finish the final 3D deliverable.',
      };
      currentJob = updateStage(currentJob, 'tour_packaging', 'completed');
      return currentJob;
    });

    const worker = getRoomTourGcpWorker();
    if (worker.enabled) {
      activeStageId = 'pose_bootstrap';
      await runRemoteRoomTourWorker(jobId);
    }

    await loadJob(jobId);
  } catch (error) {
    await setJobFailure(jobId, error, activeStageId);
    throw error;
  }
}

function startQueuedRoomTourJob(jobId) {
  if (activeRuns.has(jobId)) {
    return activeRuns.get(jobId);
  }

  const promise = runRoomTourJob(jobId)
    .catch((error) => {
      console.error(`[RoomTour] Job ${jobId} failed:`, error);
      return null;
    })
    .finally(() => {
      activeRuns.delete(jobId);
    });

  activeRuns.set(jobId, promise);
  return promise;
}

async function queueRoomTourProcessing(jobId, options = {}) {
  const job = await loadJob(jobId);

  if (!job.capture.videoUploaded) {
    throw new Error('video_not_uploaded');
  }

  const queuedJob = await mutateJob(jobId, async (currentJob) => {
    currentJob.updatedAt = nowIso();
    currentJob.status = 'queued';
    currentJob.requestedProcessing = {
      queuedAt: nowIso(),
      executionPlan: buildExecutionPlan(options),
      gcpWorkers: ROOM_TOUR_PIPELINE_SPEC.gcpWorkers,
      note: 'Queued for the completely separate room-tour system. This job will not call photogrammetry routes or publish photogrammetry scan IDs.',
    };
    currentJob = updateStage(currentJob, 'ingest', 'completed');
    currentJob = updateStage(currentJob, 'preprocess', 'queued');
    return currentJob;
  });

  void startQueuedRoomTourJob(jobId);
  return queuedJob;
}

async function resolveArtifactPath(jobId, relativePath) {
  const sanitized = path.normalize(relativePath).replace(/^([.][.][/\\])+/, '');
  const candidatePath = path.join(getJobDir(jobId), sanitized);
  const jobRoot = getJobDir(jobId);

  if (!candidatePath.startsWith(jobRoot)) {
    throw new Error('invalid_artifact_path');
  }

  await fsPromises.access(candidatePath);
  return candidatePath;
}

ensureRoomTourDataDirSync();

export {
  ROOM_TOUR_DATA_DIR,
  ROOM_TOUR_PIPELINE_SPEC,
  ROOM_TOUR_PIPELINE_VERSION,
  attachMetadataToJob,
  attachVideoToJob,
  createRoomTourJob,
  getJobDir,
  listJobs,
  loadJob,
  queueRoomTourProcessing,
  resolveArtifactPath,
};
