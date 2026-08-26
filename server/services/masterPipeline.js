import crypto from 'crypto';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import sharp from 'sharp';
import { spawn } from 'child_process';
import { getMasterPipelineGcpWorker } from './masterPipelineGcpWorker.js';
import { mirrorMasterJobToRoomScanner } from './masterPipelineRoomScanMirror.js';

const MASTER_PIPELINE_DATA_DIR = process.env.MASTER_PIPELINE_DATA_DIR || path.join(process.cwd(), 'server', 'data', 'master-jobs');
const MASTER_PIPELINE_VERSION = 'master-v1';
const MASTER_PIPELINE_EXECUTION_MODE = process.env.MASTER_PIPELINE_EXECUTION_MODE || 'master_mesh_canonical_v1';
const MASTER_FRAME_EXTRACTION_FPS = process.env.MASTER_PIPELINE_FRAME_EXTRACTION_FPS || '2';
const MASTER_MAX_SELECTED_FRAMES = parseInt(process.env.MASTER_PIPELINE_MAX_SELECTED_FRAMES || '72', 10);
const MASTER_MIN_SELECTED_FRAMES = parseInt(process.env.MASTER_PIPELINE_MIN_SELECTED_FRAMES || '6', 10);
const LOCAL_MASTER_PYTHON_PATH = path.join(process.cwd(), 'server', 'scripts', 'photogrammetry', 'venv', 'bin', 'python');
const MASTER_PIPELINE_PYTHON_PATH = process.env.MASTER_PIPELINE_PYTHON_PATH || (fs.existsSync(LOCAL_MASTER_PYTHON_PATH)
  ? LOCAL_MASTER_PYTHON_PATH
  : 'python3');
const MASTER_PIPELINE_METRIC3D_SCRIPT_PATH = path.join(process.cwd(), 'server', 'scripts', 'master_pipeline', 'run_metric3d_priors.py');
const MASTER_PIPELINE_METRIC3D_MODEL_SIZE = process.env.MASTER_PIPELINE_METRIC3D_MODEL_SIZE || 'large';
const MASTER_PIPELINE_METRIC3D_DRY_RUN = process.env.MASTER_PIPELINE_METRIC3D_DRY_RUN === 'true';
const MASTER_PIPELINE_METRIC3D_GPU_INDICES = process.env.MASTER_PIPELINE_METRIC3D_GPU_INDICES || '';
const MASTER_PIPELINE_GAUSSIAN_VIEWER_PRESET = process.env.MASTER_PIPELINE_GAUSSIAN_VIEWER_PRESET || 'sparse_first';
const MASTER_PIPELINE_LEARNED_MATCHING_SCRIPT_PATH = path.join(process.cwd(), 'server', 'scripts', 'master_pipeline', 'run_loftr_indoor_matching.py');
const MASTER_PIPELINE_LEARNED_MATCHING_PRESET = process.env.MASTER_PIPELINE_LEARNED_MATCHING_PRESET || 'aliked_superpoint_lightglue_loftr';
const MASTER_PIPELINE_LEARNED_MATCHING_IMAGE_SIZE = process.env.MASTER_PIPELINE_LEARNED_MATCHING_IMAGE_SIZE || '1024';
const MASTER_PIPELINE_LEARNED_MATCHING_GPU_INDICES = process.env.MASTER_PIPELINE_LEARNED_MATCHING_GPU_INDICES || '';
const MASTER_PIPELINE_REMOTE_GAUSSIAN_VIEWER_PRESET = process.env.MASTER_PIPELINE_REMOTE_GAUSSIAN_VIEWER_PRESET
  || process.env.MASTER_PIPELINE_GAUSSIAN_VIEWER_PRESET
  || 'sparse_first';
const MASTER_PIPELINE_REMOTE_LEARNED_MATCHING_PRESET = process.env.MASTER_PIPELINE_REMOTE_LEARNED_MATCHING_PRESET || process.env.MASTER_PIPELINE_LEARNED_MATCHING_PRESET || 'aliked_superpoint_lightglue_loftr';
const MASTER_PIPELINE_REMOTE_LEARNED_MATCHING_PRESET_LOWER = MASTER_PIPELINE_REMOTE_LEARNED_MATCHING_PRESET.toLowerCase();
const MASTER_PIPELINE_REMOTE_LEARNED_MATCHING_IMAGE_SIZE = process.env.MASTER_PIPELINE_REMOTE_LEARNED_MATCHING_IMAGE_SIZE
  || process.env.MASTER_PIPELINE_LEARNED_MATCHING_IMAGE_SIZE
  || (MASTER_PIPELINE_REMOTE_LEARNED_MATCHING_PRESET_LOWER.startsWith('fast3r') ? '512' : '1024');
const MASTER_PIPELINE_LEARNED_MATCHING_DRY_RUN = process.env.MASTER_PIPELINE_LEARNED_MATCHING_DRY_RUN === 'true';
const MASTER_PIPELINE_GLOBAL_SFM_SCRIPT_PATH = path.join(process.cwd(), 'server', 'scripts', 'master_pipeline', 'run_global_sfm.py');
const MASTER_PIPELINE_GLOBAL_SFM_DRY_RUN = process.env.MASTER_PIPELINE_GLOBAL_SFM_DRY_RUN === 'true';
const MASTER_PIPELINE_DENSE_EVIDENCE_SCRIPT_PATH = path.join(process.cwd(), 'server', 'scripts', 'master_pipeline', 'run_dense_evidence.py');
const MASTER_PIPELINE_DENSE_EVIDENCE_DRY_RUN = process.env.MASTER_PIPELINE_DENSE_EVIDENCE_DRY_RUN === 'true';
const MASTER_PIPELINE_DENSE_STEREO_GPU_INDICES = process.env.MASTER_PIPELINE_DENSE_STEREO_GPU_INDICES || '';
const MASTER_PIPELINE_GAUSSIAN_SPLATTING_DRY_RUN = process.env.MASTER_PIPELINE_GAUSSIAN_SPLATTING_DRY_RUN === 'true';
const MASTER_PIPELINE_PLANE_LAYOUT_SCRIPT_PATH = path.join(process.cwd(), 'server', 'scripts', 'master_pipeline', 'run_plane_layout.py');
const MASTER_PIPELINE_PLANE_LAYOUT_DRY_RUN = process.env.MASTER_PIPELINE_PLANE_LAYOUT_DRY_RUN === 'true';
const MASTER_PIPELINE_OPENING_DETECTION_SCRIPT_PATH = path.join(process.cwd(), 'server', 'scripts', 'master_pipeline', 'run_opening_detection.py');
const MASTER_PIPELINE_OPENING_DETECTION_DRY_RUN = process.env.MASTER_PIPELINE_OPENING_DETECTION_DRY_RUN === 'true';
const MASTER_PIPELINE_MESH_AUTHORING_SCRIPT_PATH = path.join(process.cwd(), 'server', 'scripts', 'master_pipeline', 'run_mesh_authoring.py');
const MASTER_PIPELINE_MESH_AUTHORING_DRY_RUN = process.env.MASTER_PIPELINE_MESH_AUTHORING_DRY_RUN === 'true';
const MASTER_PIPELINE_UV_INITIAL_BAKE_SCRIPT_PATH = path.join(process.cwd(), 'server', 'scripts', 'master_pipeline', 'run_uv_initial_bake.py');
const MASTER_PIPELINE_UV_INITIAL_BAKE_DRY_RUN = process.env.MASTER_PIPELINE_UV_INITIAL_BAKE_DRY_RUN === 'true';
const MASTER_PIPELINE_APPEARANCE_REFINEMENT_SCRIPT_PATH = path.join(process.cwd(), 'server', 'scripts', 'master_pipeline', 'run_appearance_refinement.py');
const MASTER_PIPELINE_APPEARANCE_REFINEMENT_DRY_RUN = process.env.MASTER_PIPELINE_APPEARANCE_REFINEMENT_DRY_RUN === 'true';
const MASTER_PIPELINE_EXPORT_QA_SCRIPT_PATH = path.join(process.cwd(), 'server', 'scripts', 'master_pipeline', 'run_export_qa.py');
const MASTER_PIPELINE_REMOTE_STAGE_IDS = [
  'metric3d_priors',
  'learned_matching',
  'global_sfm',
  'dense_evidence',
  'gaussian_splatting',
  'plane_layout',
  'opening_detection',
  'mesh_authoring',
  'uv_initial_bake',
  'appearance_refinement',
  'export_qa',
];
const MASTER_PIPELINE_RUNNING_STATUS_BY_STAGE = {
  metric3d_priors: 'running_metric3d',
  learned_matching: 'running_learned_matching',
  global_sfm: 'running_global_sfm',
  dense_evidence: 'running_dense_evidence',
  gaussian_splatting: 'running_gaussian_splatting',
  plane_layout: 'running_plane_layout',
  opening_detection: 'running_opening_detection',
  mesh_authoring: 'running_mesh_authoring',
  uv_initial_bake: 'running_uv_initial_bake',
  appearance_refinement: 'running_appearance_refinement',
  export_qa: 'running_export_qa',
};
const MASTER_PIPELINE_REMOTE_STAGE_ID_ALIASES = {
  depth_priors: 'metric3d_priors',
};
const activeRuns = new Map();

function normalizeRemoteStageId(stageId) {
  return MASTER_PIPELINE_REMOTE_STAGE_ID_ALIASES[stageId] || stageId;
}

function resolveDefaultLearnedMatchingPresetForViewerPreset(gaussianViewerPreset) {
  switch (gaussianViewerPreset) {
    case 'legacy_metric3d_masked_viewer':
    case 'legacy_metric3d_masked_viewer_balanced_density':
    case 'legacy_metric3d_masked_viewer_solid_surfaces':
    case 'legacy_metric3d_masked_viewer_solid_surfaces_sharp_mirror':
      return 'superpoint_lightglue_loftr';
    case 'legacy_metric3d_masked_viewer_disk':
      return 'disk_lightglue_loftr';
    default:
      return MASTER_PIPELINE_REMOTE_LEARNED_MATCHING_PRESET;
  }
}

function shouldPreferLegacyGaussianViewerPreset(options = {}) {
  return options.captureMode === 'room_tour'
    || options.primaryOutputIntent === 'gaussian_splats'
    || options.requireGaussianSplatting === true
    || options.gaussianOnly === true;
}

function resolveRequestedGaussianViewerPreset(options = {}, fallbackPreset = MASTER_PIPELINE_GAUSSIAN_VIEWER_PRESET) {
  if (options.gaussianViewerPreset) {
    return options.gaussianViewerPreset;
  }
  if (shouldPreferLegacyGaussianViewerPreset(options)) {
    return 'legacy_metric3d_masked_viewer_balanced_density';
  }
  return fallbackPreset;
}

function resolveDefaultSoftDepthPriorForViewerPreset(gaussianViewerPreset) {
  if (
    gaussianViewerPreset === 'legacy_metric3d_masked_viewer'
    || gaussianViewerPreset === 'legacy_metric3d_masked_viewer_balanced_density'
    || gaussianViewerPreset === 'legacy_metric3d_masked_viewer_solid_surfaces'
    || gaussianViewerPreset === 'legacy_metric3d_masked_viewer_solid_surfaces_sharp_mirror'
    || gaussianViewerPreset === 'legacy_metric3d_masked_viewer_disk'
  ) {
    return 'metric3d_v2';
  }
  return 'depth_anything_v2_post_sfm';
}

const MASTER_PIPELINE_SPEC = {
  pipelineId: 'master-reconstruction',
  version: MASTER_PIPELINE_VERSION,
  primaryGoal: 'editable_glb_mesh',
  primaryOutput: 'textured_glb_mesh',
  geometryAuthority: 'plane_aware_mesh',
  appearanceRefinement: 'splat_to_uv_sidecar',
  implementationMode: MASTER_PIPELINE_EXECUTION_MODE,
  systems: {
    intake: ['express', 'multer'],
    preprocessing: ['ffmpeg', 'sharp'],
    calibration: ['intrinsics_estimation', 'known_scale_reference'],
    softDepthPriors: ['metric3d_v2'],
    learnedMatching: ['superpoint_lightglue', 'loftr_indoor_fallback', 'roma_v2_pairwise', 'fast3r', 'colmap_geometric_verifier'],
    sfm: ['glomap_global_sfm', 'colmap_global_mapper', 'colmap_geometric_verifier', 'bundle_adjustment'],
    denseEvidence: ['colmap_mvs', 'open3d', 'confidence_fusion'],
    layout: ['vanishing_lines', 'plane_layout_solver', 'opening_detection'],
    meshing: ['architectural_shell_mesher', 'selective_detail_meshing'],
    texturing: ['uv_unwrap', 'multiview_texture_bake'],
    appearance: ['gsplat_or_3dgs_sidecar', 'uv_rebake'],
    export: ['blender_glb_export', 'gltfpack', 'qa_validation'],
  },
  blankWallPolicy: {
    geometry: 'infer_planes_from_layout_floor_ceiling_intersections_soft_priors_and_adjacent_wall_boundaries',
    texture: 'prefer_low_frequency_multiview_bake_or_clean_material_fallback_over_noisy_sparse_detail',
    reject: ['poisson_wall_noise', 'mvs_blotches', 'splat_wall_artifacts', 'hallucinated_openings'],
  },
  stages: [
    {
      id: 'ingest',
      label: 'Normalize RGB Inputs',
      systems: ['express', 'multer'],
      output: 'validated RGB images or walkthrough video',
    },
    {
      id: 'frame_qc',
      label: 'Frame Selection And Coverage',
      systems: ['ffmpeg', 'sharp'],
      output: 'selected frames with overlap and boundary coverage',
    },
    {
      id: 'camera_calibration',
      label: 'Initialize Intrinsics And Scale',
      systems: ['intrinsics_estimation', 'known_scale_reference'],
      output: 'camera model, distortion assumptions, scale state',
    },
    {
      id: 'metric3d_priors',
      label: 'Run Metric3D Soft Priors',
      systems: ['metric3d_v2'],
      output: 'soft depth and normal priors',
    },
    {
      id: 'learned_matching',
      label: 'Run Hybrid Sparse Matching',
      systems: ['superpoint_lightglue', 'loftr_indoor_fallback', 'roma_v2_pairwise', 'colmap_geometric_verifier'],
      output: 'verified low-texture learned correspondences',
    },
    {
      id: 'global_sfm',
      label: 'Solve Global SfM',
      systems: ['glomap_global_sfm', 'colmap_global_mapper', 'colmap_geometric_verifier', 'bundle_adjustment'],
      output: 'registered cameras and sparse model',
    },
    {
      id: 'dense_evidence',
      label: 'Fuse Dense Evidence',
      systems: ['colmap_mvs', 'open3d', 'confidence_fusion'],
      output: 'confidence-weighted geometry evidence cloud',
    },
    {
      id: 'gaussian_splatting',
      label: 'Train Gaussian Viewer Branch',
      systems: ['gsplat_or_3dgs_sidecar'],
      output: 'viewer-ready gaussian splat sidecar bundle',
    },
    {
      id: 'plane_layout',
      label: 'Infer Plane-Aware Layout',
      systems: ['vanishing_lines', 'plane_layout_solver'],
      output: 'clean floor, ceiling, wall, and room graph planes',
    },
    {
      id: 'opening_detection',
      label: 'Detect Openings',
      systems: ['opening_detection'],
      output: 'high-confidence doors, windows, and openings',
    },
    {
      id: 'mesh_authoring',
      label: 'Author Shell And Detail Mesh',
      systems: ['architectural_shell_mesher', 'selective_detail_meshing'],
      output: 'editable geometry with planar walls preserved',
    },
    {
      id: 'uv_initial_bake',
      label: 'Unwrap And Bake Initial Textures',
      systems: ['uv_unwrap', 'multiview_texture_bake'],
      output: 'UV mesh and baseline texture atlas',
    },
    {
      id: 'appearance_refinement',
      label: 'Rebake Splat Appearance To UVs',
      systems: ['gsplat_or_3dgs_sidecar', 'uv_rebake'],
      output: 'artifact-gated texture refinements on trusted surfaces',
    },
    {
      id: 'export_qa',
      label: 'Export Optimized GLB And Validate',
      systems: ['blender_glb_export', 'gltfpack', 'qa_validation'],
      output: 'final editable GLB plus QA reports',
    },
  ],
};

function ensureMasterDataDirSync() {
  if (!fs.existsSync(MASTER_PIPELINE_DATA_DIR)) {
    fs.mkdirSync(MASTER_PIPELINE_DATA_DIR, { recursive: true });
  }
}

async function ensureMasterDataDir() {
  await fsPromises.mkdir(MASTER_PIPELINE_DATA_DIR, { recursive: true });
}

function getJobDir(jobId) {
  return path.join(MASTER_PIPELINE_DATA_DIR, jobId);
}

function getJobManifestPath(jobId) {
  return path.join(getJobDir(jobId), 'job.json');
}

function getJobStatusPath(jobId) {
  return path.join(getJobDir(jobId), 'status.json');
}

function getJobErrorReportPath(jobId) {
  return path.join(getJobDir(jobId), 'error_report.json');
}

function getJobOutputsDir(jobId) {
  return path.join(getJobDir(jobId), 'outputs');
}

function getFramesDir(jobId) {
  return path.join(getJobDir(jobId), 'frames');
}

function getFramesRawDir(jobId) {
  return path.join(getFramesDir(jobId), 'raw');
}

function getFramesSelectedDir(jobId) {
  return path.join(getFramesDir(jobId), 'selected');
}

function getFramesRejectedDir(jobId) {
  return path.join(getFramesDir(jobId), 'rejected');
}

function getCalibrationDir(jobId) {
  return path.join(getJobDir(jobId), 'calibration');
}

function getLogsDir(jobId) {
  return path.join(getJobDir(jobId), 'logs');
}

function getPriorsDir(jobId) {
  return path.join(getJobDir(jobId), 'priors');
}

function getMetric3dDir(jobId) {
  return path.join(getPriorsDir(jobId), 'metric3d');
}

function getDepthPriorsDir(jobId) {
  return path.join(getPriorsDir(jobId), 'depth_priors');
}

function getLearnedMatchingDir(jobId) {
  return path.join(getPriorsDir(jobId), 'learned_matching');
}

function getSfmDir(jobId) {
  return path.join(getJobDir(jobId), 'sfm', 'global_sfm');
}

function getDenseEvidenceDir(jobId) {
  return path.join(getJobDir(jobId), 'dense_evidence');
}

function getGaussianSplattingDir(jobId) {
  return path.join(getJobDir(jobId), 'gaussian', 'splatting');
}

function getLayoutDir(jobId) {
  return path.join(getJobDir(jobId), 'layout');
}

function getPlaneLayoutDir(jobId) {
  return path.join(getLayoutDir(jobId), 'plane_layout');
}

function getOpeningDetectionDir(jobId) {
  return path.join(getLayoutDir(jobId), 'opening_detection');
}

function getMeshDir(jobId) {
  return path.join(getJobDir(jobId), 'mesh');
}

function getMeshAuthoringDir(jobId) {
  return path.join(getMeshDir(jobId), 'authoring');
}

function getTextureDir(jobId) {
  return path.join(getJobDir(jobId), 'texture');
}

function getUvInitialBakeDir(jobId) {
  return path.join(getTextureDir(jobId), 'uv_initial_bake');
}

function getAppearanceDir(jobId) {
  return path.join(getJobDir(jobId), 'appearance', 'refinement');
}

function getExportQaDir(jobId) {
  return path.join(getJobDir(jobId), 'export', 'qa');
}

function getArtifactUrl(jobId, relativePath) {
  return `/api/master-reconstruction/jobs/${jobId}/artifacts/${relativePath.replace(/\\/g, '/')}`;
}

function getArtifactUrlForAbsolutePath(jobId, absolutePath) {
  if (!absolutePath) {
    return null;
  }

  const relativePath = path.relative(getJobDir(jobId), absolutePath);
  return getArtifactUrl(jobId, relativePath);
}

function buildStageState() {
  return MASTER_PIPELINE_SPEC.stages.map((stage) => ({
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

function buildStatusPayload(job) {
  return {
    jobId: job.id,
    pipelineId: job.pipelineId,
    pipelineVersion: job.pipelineVersion,
    status: job.status,
    updatedAt: job.updatedAt,
    stages: job.stages,
    capture: job.capture,
    scale: job.scale,
    outputs: job.outputs,
    requestedProcessing: job.requestedProcessing,
  };
}

async function initializeJobWorkspace(jobId) {
  const directories = [
    path.join(getJobDir(jobId), 'input', 'raw_images'),
    path.join(getJobDir(jobId), 'input', 'raw_video'),
    path.join(getJobDir(jobId), 'input', 'metadata'),
    getFramesRawDir(jobId),
    getFramesSelectedDir(jobId),
    getFramesRejectedDir(jobId),
    getCalibrationDir(jobId),
    path.join(getMetric3dDir(jobId), 'depth'),
    path.join(getMetric3dDir(jobId), 'normals'),
    path.join(getMetric3dDir(jobId), 'confidence'),
    path.join(getMetric3dDir(jobId), 'previews'),
    path.join(getLearnedMatchingDir(jobId), 'pairs'),
    path.join(getLearnedMatchingDir(jobId), 'previews'),
    path.join(getSfmDir(jobId), 'sparse'),
    path.join(getSfmDir(jobId), 'text-model'),
    getDenseEvidenceDir(jobId),
    path.join(getGaussianSplattingDir(jobId), 'native-output'),
    path.join(getGaussianSplattingDir(jobId), 'workspace'),
    getPlaneLayoutDir(jobId),
    path.join(getOpeningDetectionDir(jobId), 'debug'),
    getMeshAuthoringDir(jobId),
    getUvInitialBakeDir(jobId),
    getAppearanceDir(jobId),
    getExportQaDir(jobId),
    getJobOutputsDir(jobId),
    getLogsDir(jobId),
  ];

  await Promise.all(directories.map((directory) => fsPromises.mkdir(directory, { recursive: true })));
}

async function saveJob(job) {
  await ensureMasterDataDir();
  await fsPromises.mkdir(getJobDir(job.id), { recursive: true });
  await fsPromises.writeFile(getJobManifestPath(job.id), JSON.stringify(job, null, 2));
  await fsPromises.writeFile(getJobStatusPath(job.id), JSON.stringify(buildStatusPayload(job), null, 2));
  return job;
}

async function readJob(jobId) {
  return JSON.parse(await fsPromises.readFile(getJobManifestPath(jobId), 'utf8'));
}

async function mutateJob(jobId, mutate) {
  const job = await readJob(jobId);
  const nextJob = await mutate(job);
  return saveJob(nextJob);
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

function hasInput(job) {
  return Boolean(job.capture.videoUploaded || job.capture.imageCount > 0);
}

function buildExecutionPlan(options = {}) {
  const gaussianOnly = options.gaussianOnly === true;
  const metric3dMeshSidecar = options.metric3dMeshSidecar === true;
  const metric3dMeshOnly = options.metric3dMeshOnly === true;
  const gaussianViewerPreset = resolveRequestedGaussianViewerPreset(options, MASTER_PIPELINE_GAUSSIAN_VIEWER_PRESET);
  const learnedMatching = options.learnedMatching
    || options.learnedMatchingPreset
    || resolveDefaultLearnedMatchingPresetForViewerPreset(gaussianViewerPreset);
  const softDepthPrior = options.softDepthPrior || resolveDefaultSoftDepthPriorForViewerPreset(gaussianViewerPreset);

  return {
    geometryAuthority: MASTER_PIPELINE_SPEC.geometryAuthority,
    implementationMode: MASTER_PIPELINE_EXECUTION_MODE,
    preGeometryExecutor: 'local_master_service_v1',
    captureMode: options.captureMode || 'rgb_capture',
    gaussianViewerPreset,
    learnedMatching,
    softDepthPrior,
    sfmBackend: options.sfmBackend || 'glomap_or_colmap_global_mapper_required',
    denseEvidence: ['colmap_mvs', 'metric3d_world_priors', 'hybrid_verified_matches'],
    gaussianOnly,
    metric3dMeshSidecar,
    metric3dMeshOnly,
    gaussianBranch: metric3dMeshOnly ? 'disabled' : (options.gaussianBranch || 'post_glomap_viewer_sidecar'),
    blankWallStrategy: 'plane_layout_plus_clean_material_fallback',
    appearanceRefinement: metric3dMeshOnly ? 'openmvs_uv_bake' : (options.appearanceRefinement || 'gsplat_to_uv_sidecar'),
    primaryOutputIntent: options.primaryOutputIntent || (metric3dMeshOnly ? 'textured_glb_mesh' : 'textured_glb_mesh'),
    finalAsset: metric3dMeshOnly || options.primaryOutputIntent !== 'gaussian_splats'
      ? 'optimized_glb_mesh'
      : (gaussianOnly ? 'gaussian_splat_viewer_primary_only' : 'gaussian_splat_viewer_with_mesh_sidecar'),
  };
}

async function writeExecutionContract(job, options = {}) {
  const outputsDir = getJobOutputsDir(job.id);
  const executionContract = {
    jobId: job.id,
    createdAt: nowIso(),
    pipeline: {
      id: MASTER_PIPELINE_SPEC.pipelineId,
      version: MASTER_PIPELINE_SPEC.version,
      executionMode: MASTER_PIPELINE_EXECUTION_MODE,
    },
    orchestrator: {
      scriptPath: path.join(process.cwd(), 'server', 'scripts', 'master_pipeline', 'orchestrator.py'),
      status: 'stages_1_to_13_live',
      note: 'Stage 1 through Stage 13 now execute through the master_v1 service contract. Geometry remains layout-driven, with optional sidecars for refinement and optimization.',
    },
    inputs: {
      videoPath: job.capture.videoPath,
      imagesDir: job.capture.imagesDir,
      imageCount: job.capture.imageCount,
      metadataPath: job.capture.metadataPath,
      selectedFramesDir: job.capture.selectedFramesDir || null,
      selectedFrameCount: job.capture.selectedFrameCount || 0,
      scale: job.scale,
    },
    blankWallPolicy: MASTER_PIPELINE_SPEC.blankWallPolicy,
    executionPlan: buildExecutionPlan(options),
    outputs: job.outputs,
    stages: MASTER_PIPELINE_SPEC.stages,
  };

  await fsPromises.mkdir(outputsDir, { recursive: true });
  await fsPromises.writeFile(path.join(outputsDir, 'master-execution-plan.json'), JSON.stringify(executionContract, null, 2));
}

async function listJobs() {
  await ensureMasterDataDir();
  const entries = await fsPromises.readdir(MASTER_PIPELINE_DATA_DIR, { withFileTypes: true });
  const jobs = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    try {
      jobs.push(await readJob(entry.name));
    } catch {
      // Ignore incomplete directories.
    }
  }

  return jobs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

async function loadJob(jobId) {
  return readJob(jobId);
}

async function createMasterJob(input = {}) {
  const jobId = `master_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  const createdAt = nowIso();
  await initializeJobWorkspace(jobId);

  const job = {
    id: jobId,
    createdAt,
    updatedAt: createdAt,
    status: 'created',
    pipelineId: MASTER_PIPELINE_SPEC.pipelineId,
    pipelineVersion: MASTER_PIPELINE_SPEC.version,
    primaryOutput: MASTER_PIPELINE_SPEC.primaryOutput,
    geometryAuthority: MASTER_PIPELINE_SPEC.geometryAuthority,
    jobName: input.jobName || 'Untitled Master Reconstruction',
    propertyId: input.propertyId || null,
    userId: input.userId || null,
    metadata: {
      captureMode: input.captureMode || 'rgb_capture',
      notes: input.notes || null,
      executionMode: MASTER_PIPELINE_EXECUTION_MODE,
      canonicalSystem: true,
    },
    scale: {
      status: 'unknown',
      referenceType: null,
      referenceValue: null,
      measurementGrade: false,
      measurementGradeReason: 'known_scale_reference_missing',
    },
    capture: {
      imageCount: 0,
      imagesDir: null,
      imageFilenames: [],
      videoUploaded: false,
      videoPath: null,
      metadataPath: null,
      rawFrameCount: 0,
      selectedFrameCount: 0,
      rejectedFrameCount: 0,
      selectedFramesDir: null,
    },
    stages: buildStageState(),
    systems: MASTER_PIPELINE_SPEC.systems,
    requestedProcessing: null,
    outputs: {
      executionPlanPath: null,
      frameQcManifestPath: null,
      selectedContactSheetPath: null,
      rejectedContactSheetPath: null,
      intrinsicsPath: null,
      distortionPath: null,
      scalePath: null,
      cameraReportPath: null,
      metric3dSummaryPath: null,
      metric3dDepthDir: null,
      metric3dNormalsDir: null,
      metric3dConfidenceDir: null,
      metric3dPreviewDir: null,
      learnedMatchingSummaryPath: null,
      learnedMatchingMatchGraphPath: null,
      learnedMatchingFeatureStorePath: null,
      learnedMatchingMatchesStorePath: null,
      learnedMatchingTrackStorePath: null,
      learnedMatchingPairsDir: null,
      learnedMatchingPreviewDir: null,
      globalSfmSummaryPath: null,
      globalSfmDatabasePath: null,
      globalSfmSparseModelDir: null,
      globalSfmTextModelDir: null,
      globalSfmCamerasPath: null,
      globalSfmImagesPath: null,
      globalSfmPointsPath: null,
      fast3rPointmapTailRescueSummaryPath: null,
      fast3rPointmapTailRescueTextModelDir: null,
      fast3rPointmapTailRescueImagesPath: null,
      fast3rPointmapTailRescuePointsPath: null,
      fast3rPointmapTailRescuePosesPath: null,
      experimentalMultiviewSummaryPath: null,
      experimentalMultiviewBundlePath: null,
      experimentalMultiviewCameraGraphPath: null,
      experimentalMultiviewPoseGraphPath: null,
      denseEvidenceSummaryPath: null,
      denseEvidencePointCloudPath: null,
      denseEvidencePointsPath: null,
      denseEvidenceColorsPath: null,
      gaussianSummaryPath: null,
      gaussianScenePath: null,
      gaussianPlyPath: null,
      gaussianViewerPath: null,
      refGaussianSummaryPath: null,
      refGaussianScenePath: null,
      refGaussianPlyPath: null,
      refGaussianViewerPath: null,
      refGaussianNativeRenderContractPath: null,
      refGaussianNativeRenderContractManifestPath: null,
      planeLayoutSummaryPath: null,
      planeLayoutPath: null,
      openingDetectionSummaryPath: null,
      openingCandidatesPath: null,
      openingDebugDir: null,
      meshAuthoringSummaryPath: null,
      shellMeshPath: null,
      shellMeshPlyPath: null,
      meshPanelBreakdownPath: null,
      detailMeshSummaryPath: null,
      uvInitialBakeSummaryPath: null,
      uvTexturedMeshPath: null,
      uvTexturePath: null,
      appearanceSummaryPath: null,
      refinedMeshPath: null,
      refinedTexturePath: null,
      exportSummaryPath: null,
      finalGlbPath: null,
      optimizedGlbPath: null,
      qaReportPath: null,
    },
  };

  return saveJob(job);
}

async function attachImagesToJob(jobId, files) {
  if (!files || files.length === 0) {
    throw new Error('images_required');
  }

  let job = await readJob(jobId);
  job.updatedAt = nowIso();
  job.status = 'input_uploaded';
  job.capture.imageCount = files.length;
  job.capture.imagesDir = files[0] ? path.dirname(files[0].path) : null;
  job.capture.imageFilenames = files.map((file) => path.basename(file.path));
  job = updateStage(job, 'ingest', 'completed');
  return saveJob(job);
}

async function attachVideoToJob(jobId, file) {
  let job = await readJob(jobId);
  job.updatedAt = nowIso();
  job.status = 'input_uploaded';
  job.capture.videoUploaded = true;
  job.capture.videoPath = file.path;
  job.capture.originalVideoFilename = file.originalname;
  job.capture.videoMimeType = file.mimetype;
  job.capture.videoSize = file.size;
  job = updateStage(job, 'ingest', 'completed');
  return saveJob(job);
}

async function attachMetadataToJob(jobId, metadata) {
  const job = await readJob(jobId);
  const metadataPath = path.join(getJobDir(jobId), 'input', 'metadata', 'capture-metadata.json');

  await fsPromises.mkdir(path.dirname(metadataPath), { recursive: true });
  await fsPromises.writeFile(metadataPath, JSON.stringify(metadata, null, 2));

  const scaleReference = metadata.scaleReference || metadata.knownScale || null;
  job.updatedAt = nowIso();
  job.capture.metadataPath = metadataPath;
  job.metadata = {
    ...job.metadata,
    ...metadata,
  };
  if (scaleReference) {
    job.scale = {
      status: 'known_reference_supplied',
      referenceType: scaleReference.type || metadata.scaleReferenceType || 'user_reference',
      referenceValue: scaleReference.value || metadata.scaleReferenceValue || null,
      measurementGrade: false,
      measurementGradeReason: 'awaiting_geometry_validation',
    };
  }

  return saveJob(job);
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

async function readJsonFile(filePath) {
  return JSON.parse(await fsPromises.readFile(filePath, 'utf8'));
}

async function readJsonFileIfPresent(filePath) {
  try {
    return await readJsonFile(filePath);
  } catch {
    return null;
  }
}

async function resolveRemoteDepthPriorArtifacts(jobId) {
  const remoteResult = await readJsonFileIfPresent(path.join(getJobOutputsDir(jobId), 'master_pipeline_remote_result.json'));
  const preferredStageId = remoteResult?.activeDepthPriorStage || null;
  const candidates = [];

  const pushCandidate = (stageId, dirPath, artifactSubdir) => {
    if (!stageId || candidates.some((candidate) => candidate.stageId === stageId)) {
      return;
    }
    candidates.push({ stageId, dirPath, artifactSubdir });
  };

  if (preferredStageId === 'metric3d_priors') {
    pushCandidate('metric3d_priors', getMetric3dDir(jobId), path.join('priors', 'metric3d'));
  } else if (preferredStageId === 'depth_priors') {
    pushCandidate('depth_priors', getDepthPriorsDir(jobId), path.join('priors', 'depth_priors'));
  }

  pushCandidate('metric3d_priors', getMetric3dDir(jobId), path.join('priors', 'metric3d'));
  pushCandidate('depth_priors', getDepthPriorsDir(jobId), path.join('priors', 'depth_priors'));

  for (const candidate of candidates) {
    const summary = await readJsonFileIfPresent(path.join(candidate.dirPath, 'summary.json'));
    if (summary) {
      return {
        ...candidate,
        summary,
      };
    }
  }

  return {
    ...(candidates[0] || {
      stageId: preferredStageId || 'metric3d_priors',
      dirPath: preferredStageId === 'depth_priors' ? getDepthPriorsDir(jobId) : getMetric3dDir(jobId),
      artifactSubdir: preferredStageId === 'depth_priors' ? path.join('priors', 'depth_priors') : path.join('priors', 'metric3d'),
    }),
    summary: null,
  };
}

function buildDepthPriorArtifactUrls(jobId, artifactSubdir) {
  return {
    summaryPath: getArtifactUrl(jobId, path.join(artifactSubdir, 'summary.json')),
    depthDir: getArtifactUrl(jobId, path.join(artifactSubdir, 'depth')),
    normalsDir: getArtifactUrl(jobId, path.join(artifactSubdir, 'normals')),
    confidenceDir: getArtifactUrl(jobId, path.join(artifactSubdir, 'confidence')),
    previewDir: getArtifactUrl(jobId, path.join(artifactSubdir, 'previews')),
  };
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

  let brightnessTotal = 0;
  for (const value of data) {
    brightnessTotal += value;
  }

  return {
    sample: data,
    edgeScore: calculateEdgeScore(data),
    brightness: brightnessTotal / data.length,
  };
}

function fillFrameSelection(framePaths, selectedFrames) {
  if (selectedFrames.length >= MASTER_MIN_SELECTED_FRAMES || framePaths.length <= selectedFrames.length) {
    return selectedFrames;
  }

  const selectedSet = new Set(selectedFrames.map((entry) => entry.path));
  const nextSelection = [...selectedFrames];

  while (nextSelection.length < Math.min(MASTER_MIN_SELECTED_FRAMES, framePaths.length)) {
    const ratio = nextSelection.length / Math.max(MASTER_MIN_SELECTED_FRAMES - 1, 1);
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

function escapeSvgText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function writePlaceholderContactSheet(destinationPath, title, subtitle) {
  const svg = `
    <svg width="1280" height="720" xmlns="http://www.w3.org/2000/svg">
      <rect width="1280" height="720" fill="#111827" />
      <text x="80" y="180" fill="#f9fafb" font-size="44" font-family="Arial, sans-serif">${escapeSvgText(title)}</text>
      <text x="80" y="250" fill="#9ca3af" font-size="28" font-family="Arial, sans-serif">${escapeSvgText(subtitle)}</text>
    </svg>
  `;

  await sharp(Buffer.from(svg))
    .jpeg({ quality: 92 })
    .toFile(destinationPath);
}

async function writeContactSheet(framePaths, destinationPath, title) {
  const limitedFrames = framePaths.slice(0, 24);
  if (limitedFrames.length === 0) {
    await writePlaceholderContactSheet(destinationPath, title, 'No frames available for this set');
    return;
  }

  const thumbWidth = 320;
  const thumbHeight = 180;
  const columns = 4;
  const headerHeight = 96;
  const rows = Math.ceil(limitedFrames.length / columns);
  const width = columns * thumbWidth;
  const height = headerHeight + (rows * thumbHeight);
  const composites = [
    {
      input: Buffer.from(`
        <svg width="${width}" height="${headerHeight}" xmlns="http://www.w3.org/2000/svg">
          <rect width="${width}" height="${headerHeight}" fill="#111827" />
          <text x="32" y="58" fill="#f9fafb" font-size="34" font-family="Arial, sans-serif">${escapeSvgText(title)}</text>
          <text x="32" y="84" fill="#9ca3af" font-size="18" font-family="Arial, sans-serif">Showing ${limitedFrames.length} frames</text>
        </svg>
      `),
      left: 0,
      top: 0,
    },
  ];

  const thumbnails = await Promise.all(limitedFrames.map((framePath, index) => sharp(framePath)
    .resize(thumbWidth, thumbHeight, { fit: 'cover' })
    .jpeg({ quality: 82 })
    .toBuffer()
    .then((buffer) => ({
      input: buffer,
      left: (index % columns) * thumbWidth,
      top: headerHeight + (Math.floor(index / columns) * thumbHeight),
    }))));

  await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: '#0f172a',
    },
  })
    .composite([...composites, ...thumbnails])
    .jpeg({ quality: 90 })
    .toFile(destinationPath);
}

async function normalizeImagesToRawFrames(job) {
  const rawFramesDir = getFramesRawDir(job.id);
  await fsPromises.rm(rawFramesDir, { recursive: true, force: true });
  await fsPromises.mkdir(rawFramesDir, { recursive: true });

  const sourceDir = job.capture.imagesDir;
  if (!sourceDir) {
    throw new Error('master_image_source_missing');
  }

  const sourceFiles = (await fsPromises.readdir(sourceDir))
    .filter((entry) => /\.(jpe?g|png|heic|heif)$/i.test(entry))
    .sort();

  if (sourceFiles.length === 0) {
    throw new Error('master_image_source_empty');
  }

  async function normalizeSourceImage(sourcePath, destinationPath) {
    try {
      await sharp(sourcePath)
        .rotate()
        .jpeg({ quality: 92 })
        .toFile(destinationPath);
      return;
    } catch (error) {
      const isHeicSource = /\.(heic|heif)$/i.test(sourcePath);
      if (!isHeicSource || process.platform !== 'darwin') {
        throw error;
      }

      const sipsConvertedPath = `${destinationPath}.sips.jpg`;
      await fsPromises.rm(sipsConvertedPath, { force: true });
      try {
        await runCommand('sips', ['-s', 'format', 'jpeg', sourcePath, '--out', sipsConvertedPath]);
        await sharp(sipsConvertedPath)
          .rotate()
          .jpeg({ quality: 92 })
          .toFile(destinationPath);
      } finally {
        await fsPromises.rm(sipsConvertedPath, { force: true });
      }
    }
  }

  const normalizedFrames = [];
  for (let index = 0; index < sourceFiles.length; index += 1) {
    const sourcePath = path.join(sourceDir, sourceFiles[index]);
    const destinationPath = path.join(rawFramesDir, `frame_${String(index + 1).padStart(5, '0')}.jpg`);
    await normalizeSourceImage(sourcePath, destinationPath);
    normalizedFrames.push(destinationPath);
  }

  return normalizedFrames;
}

async function extractFramesFromVideo(job) {
  await ensureFfmpegAvailable();

  const rawFramesDir = getFramesRawDir(job.id);
  await fsPromises.rm(rawFramesDir, { recursive: true, force: true });
  await fsPromises.mkdir(rawFramesDir, { recursive: true });

  const outputPattern = path.join(rawFramesDir, 'frame_%05d.jpg');
  await runCommand('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-i', job.capture.videoPath,
    '-vf', `fps=${MASTER_FRAME_EXTRACTION_FPS},scale=-2:1440`,
    '-q:v', '2',
    outputPattern,
  ]);

  const extractedFrames = (await fsPromises.readdir(rawFramesDir))
    .filter((entry) => entry.toLowerCase().endsWith('.jpg'))
    .sort()
    .map((entry) => path.join(rawFramesDir, entry));

  if (extractedFrames.length === 0) {
    throw new Error('master_video_frame_extraction_empty');
  }

  return extractedFrames;
}

async function buildRawFrameSet(job) {
  if (job.capture.videoUploaded) {
    return extractFramesFromVideo(job);
  }

  return normalizeImagesToRawFrames(job);
}

async function prepareFramesAndQc(job) {
  const rawFramePaths = await buildRawFrameSet(job);
  const selectedDir = getFramesSelectedDir(job.id);
  const rejectedDir = getFramesRejectedDir(job.id);
  const frameQcManifestPath = path.join(getFramesDir(job.id), 'frame_qc.json');
  const selectedContactSheetPath = path.join(getFramesDir(job.id), 'contact_sheet_selected.jpg');
  const rejectedContactSheetPath = path.join(getFramesDir(job.id), 'contact_sheet_rejected.jpg');

  await fsPromises.rm(selectedDir, { recursive: true, force: true });
  await fsPromises.rm(rejectedDir, { recursive: true, force: true });
  await fsPromises.mkdir(selectedDir, { recursive: true });
  await fsPromises.mkdir(rejectedDir, { recursive: true });

  const analyses = [];
  for (const framePath of rawFramePaths) {
    const analysis = await analyzeFrame(framePath);
    analyses.push({ path: framePath, ...analysis });
  }

  const selectedFrames = [];
  let previousSample = null;
  let lastAcceptedIndex = -99;

  for (let index = 0; index < analyses.length; index += 1) {
    const frame = analyses[index];
    const differenceScore = previousSample
      ? averageAbsoluteDifference(frame.sample, previousSample)
      : Number.POSITIVE_INFINITY;
    const keepForCoverage = selectedFrames.length === 0 || (index - lastAcceptedIndex) >= 2;
    const keepForMotion = differenceScore >= 10;
    const keepForDetail = frame.edgeScore >= 4;
    const brightnessUsable = frame.brightness >= 12 && frame.brightness <= 245;

    if (((keepForMotion || keepForCoverage || keepForDetail) && brightnessUsable) || keepForCoverage) {
      if (selectedFrames.length < MASTER_MAX_SELECTED_FRAMES) {
        selectedFrames.push({
          path: frame.path,
          reason: keepForMotion ? 'motion_delta' : (keepForDetail ? 'detail' : 'coverage'),
          edgeScore: Number(frame.edgeScore.toFixed(2)),
          brightness: Number(frame.brightness.toFixed(2)),
          differenceScore: Number.isFinite(differenceScore) ? Number(differenceScore.toFixed(2)) : null,
        });
        previousSample = frame.sample;
        lastAcceptedIndex = index;
      }
    }
  }

  const finalizedSelection = fillFrameSelection(rawFramePaths, selectedFrames).slice(0, MASTER_MAX_SELECTED_FRAMES);
  const selectedSet = new Set(finalizedSelection.map((entry) => entry.path));
  const rejectedFrames = analyses
    .filter((entry) => !selectedSet.has(entry.path))
    .map((entry) => ({
      path: entry.path,
      reason: 'not_selected',
      edgeScore: Number(entry.edgeScore.toFixed(2)),
      brightness: Number(entry.brightness.toFixed(2)),
    }));

  if (finalizedSelection.length < Math.min(MASTER_MIN_SELECTED_FRAMES, rawFramePaths.length)) {
    throw new Error(`master_frame_qc_too_few_selected:${finalizedSelection.length}`);
  }

  const selectedFramePaths = [];
  for (let index = 0; index < finalizedSelection.length; index += 1) {
    const selectedFrame = finalizedSelection[index];
    const destinationPath = path.join(selectedDir, `selected_${String(index + 1).padStart(4, '0')}.jpg`);
    await fsPromises.copyFile(selectedFrame.path, destinationPath);
    selectedFramePaths.push(destinationPath);
  }

  const rejectedFramePaths = [];
  for (let index = 0; index < rejectedFrames.length; index += 1) {
    const rejectedFrame = rejectedFrames[index];
    const destinationPath = path.join(rejectedDir, `rejected_${String(index + 1).padStart(4, '0')}.jpg`);
    await fsPromises.copyFile(rejectedFrame.path, destinationPath);
    rejectedFramePaths.push(destinationPath);
  }

  await writeContactSheet(selectedFramePaths, selectedContactSheetPath, 'Master v1 Selected Frames');
  await writeContactSheet(rejectedFramePaths, rejectedContactSheetPath, 'Master v1 Rejected Frames');

  const manifest = {
    createdAt: nowIso(),
    inputMode: job.capture.videoUploaded ? 'video' : 'images',
    extractionFps: job.capture.videoUploaded ? MASTER_FRAME_EXTRACTION_FPS : null,
    rawFrameCount: rawFramePaths.length,
    selectedFrameCount: selectedFramePaths.length,
    rejectedFrameCount: rejectedFramePaths.length,
    selectedFrames: finalizedSelection.map((entry, index) => ({
      source: path.basename(entry.path),
      output: path.basename(selectedFramePaths[index]),
      reason: entry.reason,
      edgeScore: entry.edgeScore ?? null,
      brightness: entry.brightness ?? null,
      differenceScore: entry.differenceScore ?? null,
    })),
    rejectedFrames: rejectedFrames.slice(0, 50).map((entry, index) => ({
      source: path.basename(entry.path),
      output: rejectedFramePaths[index] ? path.basename(rejectedFramePaths[index]) : null,
      reason: entry.reason,
      edgeScore: entry.edgeScore ?? null,
      brightness: entry.brightness ?? null,
    })),
  };

  await fsPromises.writeFile(frameQcManifestPath, JSON.stringify(manifest, null, 2));

  return {
    frameQcManifestPath,
    selectedContactSheetPath,
    rejectedContactSheetPath,
    rawFrameCount: rawFramePaths.length,
    selectedFrameCount: selectedFramePaths.length,
    rejectedFrameCount: rejectedFramePaths.length,
    selectedFramePaths,
    selectedFramesDir: selectedDir,
  };
}

async function runCalibration(job, frameQcResult) {
  const calibrationDir = getCalibrationDir(job.id);
  await fsPromises.mkdir(calibrationDir, { recursive: true });

  const selectedFramePath = frameQcResult.selectedFramePaths[0];
  const imageMetadata = await sharp(selectedFramePath).metadata();
  const width = imageMetadata.width;
  const height = imageMetadata.height;

  if (!width || !height) {
    throw new Error('master_calibration_missing_image_dimensions');
  }

  const suppliedIntrinsics = job.metadata.cameraIntrinsics || job.metadata.intrinsics || null;
  const intrinsicSource = suppliedIntrinsics ? 'metadata' : 'heuristic_default';
  const intrinsics = {
    model: job.metadata.cameraModel || 'PINHOLE',
    width,
    height,
    fx: Number((suppliedIntrinsics?.fx || suppliedIntrinsics?.focalLengthX || (1.2 * width)).toFixed(4)),
    fy: Number((suppliedIntrinsics?.fy || suppliedIntrinsics?.focalLengthY || (1.2 * width)).toFixed(4)),
    cx: Number((suppliedIntrinsics?.cx || (width / 2)).toFixed(4)),
    cy: Number((suppliedIntrinsics?.cy || (height / 2)).toFixed(4)),
    source: intrinsicSource,
  };

  const distortion = {
    model: job.metadata.distortionModel || 'none',
    k1: Number(job.metadata.k1 || 0),
    k2: Number(job.metadata.k2 || 0),
    p1: Number(job.metadata.p1 || 0),
    p2: Number(job.metadata.p2 || 0),
    k3: Number(job.metadata.k3 || 0),
    source: job.metadata.distortionModel ? 'metadata' : 'zero_default',
  };

  const scale = {
    status: job.scale.status === 'known_reference_supplied' ? 'known' : 'estimated',
    referenceType: job.scale.referenceType,
    referenceValue: job.scale.referenceValue,
    measurementGrade: false,
    measurementGradeReason: job.scale.status === 'known_reference_supplied'
      ? 'awaiting_geometry_validation'
      : 'known_scale_reference_missing',
  };

  const cameraReport = {
    createdAt: nowIso(),
    selectedFrame: path.basename(selectedFramePath),
    imageWidth: width,
    imageHeight: height,
    cameraModel: intrinsics.model,
    intrinsicsSource: intrinsicSource,
    distortionSource: distortion.source,
    scaleStatus: scale.status,
    note: 'Stage 3 initializes calibration and scale state only. Measurement-grade output remains blocked until downstream geometry validation passes.',
  };

  const intrinsicsPath = path.join(calibrationDir, 'intrinsics.json');
  const distortionPath = path.join(calibrationDir, 'distortion.json');
  const scalePath = path.join(calibrationDir, 'scale.json');
  const cameraReportPath = path.join(calibrationDir, 'camera_report.json');

  await fsPromises.writeFile(intrinsicsPath, JSON.stringify(intrinsics, null, 2));
  await fsPromises.writeFile(distortionPath, JSON.stringify(distortion, null, 2));
  await fsPromises.writeFile(scalePath, JSON.stringify(scale, null, 2));
  await fsPromises.writeFile(cameraReportPath, JSON.stringify(cameraReport, null, 2));

  return {
    intrinsicsPath,
    distortionPath,
    scalePath,
    cameraReportPath,
    scale,
  };
}

async function runMetric3dPriors(job) {
  const metric3dDir = getMetric3dDir(job.id);
  const metric3dLogPath = path.join(getLogsDir(job.id), 'metric3d.log');

  await fsPromises.rm(metric3dDir, { recursive: true, force: true });
  await fsPromises.mkdir(path.join(metric3dDir, 'depth'), { recursive: true });
  await fsPromises.mkdir(path.join(metric3dDir, 'normals'), { recursive: true });
  await fsPromises.mkdir(path.join(metric3dDir, 'confidence'), { recursive: true });
  await fsPromises.mkdir(path.join(metric3dDir, 'previews'), { recursive: true });

  if (!job.capture.selectedFramesDir) {
    throw new Error('master_metric3d_selected_frames_missing');
  }

  const args = [
    MASTER_PIPELINE_METRIC3D_SCRIPT_PATH,
    '--job-id', job.id,
    '--images-dir', job.capture.selectedFramesDir,
    '--calibration-dir', getCalibrationDir(job.id),
    '--output-dir', metric3dDir,
    '--model-size', MASTER_PIPELINE_METRIC3D_MODEL_SIZE,
  ];

  if (MASTER_PIPELINE_METRIC3D_GPU_INDICES) {
    args.push('--gpu-indices', MASTER_PIPELINE_METRIC3D_GPU_INDICES);
  }

  if (MASTER_PIPELINE_METRIC3D_DRY_RUN) {
    args.push('--dry-run');
  }

  const { stdout, stderr } = await runCommand(MASTER_PIPELINE_PYTHON_PATH, args);
  await fsPromises.writeFile(metric3dLogPath, [stdout.trim(), stderr.trim()].filter(Boolean).join('\n\n'));

  const summaryPath = path.join(metric3dDir, 'summary.json');
  const summary = await readJsonFile(summaryPath);

  return {
    summary,
    summaryPath,
    logPath: metric3dLogPath,
  };
}

async function runLearnedMatching(job) {
  const learnedMatchingDir = getLearnedMatchingDir(job.id);
  const learnedMatchingLogPath = path.join(getLogsDir(job.id), 'learned_matching.log');

  await fsPromises.rm(learnedMatchingDir, { recursive: true, force: true });
  await fsPromises.mkdir(path.join(learnedMatchingDir, 'pairs'), { recursive: true });
  await fsPromises.mkdir(path.join(learnedMatchingDir, 'previews'), { recursive: true });

  if (!job.capture.selectedFramesDir) {
    throw new Error('master_learned_matching_selected_frames_missing');
  }

  const args = [
    MASTER_PIPELINE_LEARNED_MATCHING_SCRIPT_PATH,
    '--job-id', job.id,
    '--images-dir', job.capture.selectedFramesDir,
    '--output-dir', learnedMatchingDir,
    '--preset', MASTER_PIPELINE_LEARNED_MATCHING_PRESET,
    '--image-size', MASTER_PIPELINE_LEARNED_MATCHING_IMAGE_SIZE,
  ];

  if (MASTER_PIPELINE_LEARNED_MATCHING_GPU_INDICES) {
    args.push('--gpu-indices', MASTER_PIPELINE_LEARNED_MATCHING_GPU_INDICES);
  }

  if (MASTER_PIPELINE_LEARNED_MATCHING_DRY_RUN) {
    args.push('--dry-run');
  }

  const { stdout, stderr } = await runCommand(MASTER_PIPELINE_PYTHON_PATH, args);
  await fsPromises.writeFile(learnedMatchingLogPath, [stdout.trim(), stderr.trim()].filter(Boolean).join('\n\n'));

  const summaryPath = path.join(learnedMatchingDir, 'summary.json');
  const summary = await readJsonFile(summaryPath);

  return {
    summary,
    summaryPath,
    matchGraphPath: path.join(learnedMatchingDir, 'match_graph.json'),
    featureStorePath: path.join(learnedMatchingDir, 'feature_store.json'),
    matchesStorePath: path.join(learnedMatchingDir, 'matches_store.json'),
    logPath: learnedMatchingLogPath,
  };
}

async function runGlobalSfm(job) {
  const sfmDir = getSfmDir(job.id);
  const sfmLogPath = path.join(getLogsDir(job.id), 'global_sfm.log');

  await fsPromises.rm(sfmDir, { recursive: true, force: true });
  await fsPromises.mkdir(path.join(sfmDir, 'sparse'), { recursive: true });
  await fsPromises.mkdir(path.join(sfmDir, 'text-model'), { recursive: true });

  if (!job.capture.selectedFramesDir) {
    throw new Error('master_global_sfm_selected_frames_missing');
  }

  const args = [
    MASTER_PIPELINE_GLOBAL_SFM_SCRIPT_PATH,
    '--job-id', job.id,
    '--images-dir', job.capture.selectedFramesDir,
    '--output-dir', sfmDir,
    '--learned-match-graph-path', path.join(getLearnedMatchingDir(job.id), 'match_graph.json'),
    '--learned-feature-store-path', path.join(getLearnedMatchingDir(job.id), 'feature_store.json'),
    '--learned-matches-store-path', path.join(getLearnedMatchingDir(job.id), 'matches_store.json'),
  ];

  if (MASTER_PIPELINE_GLOBAL_SFM_DRY_RUN) {
    args.push('--dry-run');
  }

  const { stdout, stderr } = await runCommand(MASTER_PIPELINE_PYTHON_PATH, args);
  await fsPromises.writeFile(sfmLogPath, [stdout.trim(), stderr.trim()].filter(Boolean).join('\n\n'));

  const summaryPath = path.join(sfmDir, 'summary.json');
  const summary = await readJsonFile(summaryPath);

  return {
    summary,
    summaryPath,
    logPath: sfmLogPath,
  };
}

async function runDenseEvidence(job) {
  const denseEvidenceDir = getDenseEvidenceDir(job.id);
  const denseEvidenceLogPath = path.join(getLogsDir(job.id), 'dense_evidence.log');

  await fsPromises.rm(denseEvidenceDir, { recursive: true, force: true });
  await fsPromises.mkdir(denseEvidenceDir, { recursive: true });

  if (!job.capture.selectedFramesDir) {
    throw new Error('master_dense_evidence_selected_frames_missing');
  }

  const args = [
    MASTER_PIPELINE_DENSE_EVIDENCE_SCRIPT_PATH,
    '--job-id', job.id,
    '--images-dir', job.capture.selectedFramesDir,
    '--sfm-text-model-dir', path.join(getSfmDir(job.id), 'text-model'),
    '--metric3d-dir', getMetric3dDir(job.id),
    '--learned-matching-dir', getLearnedMatchingDir(job.id),
    '--output-dir', denseEvidenceDir,
  ];

  if (MASTER_PIPELINE_DENSE_STEREO_GPU_INDICES) {
    args.push('--patch-match-gpu-indices', MASTER_PIPELINE_DENSE_STEREO_GPU_INDICES);
  }

  if (MASTER_PIPELINE_DENSE_EVIDENCE_DRY_RUN) {
    args.push('--dry-run');
  }

  const { stdout, stderr } = await runCommand(MASTER_PIPELINE_PYTHON_PATH, args);
  await fsPromises.writeFile(denseEvidenceLogPath, [stdout.trim(), stderr.trim()].filter(Boolean).join('\n\n'));

  const summaryPath = path.join(denseEvidenceDir, 'summary.json');
  const summary = await readJsonFile(summaryPath);

  return {
    summary,
    summaryPath,
    logPath: denseEvidenceLogPath,
  };
}

async function runPlaneLayout(job) {
  const planeLayoutDir = getPlaneLayoutDir(job.id);
  const planeLayoutLogPath = path.join(getLogsDir(job.id), 'plane_layout.log');

  await fsPromises.rm(planeLayoutDir, { recursive: true, force: true });
  await fsPromises.mkdir(planeLayoutDir, { recursive: true });

  const args = [
    MASTER_PIPELINE_PLANE_LAYOUT_SCRIPT_PATH,
    '--job-id', job.id,
    '--dense-evidence-dir', getDenseEvidenceDir(job.id),
    '--output-dir', planeLayoutDir,
  ];

  if (MASTER_PIPELINE_PLANE_LAYOUT_DRY_RUN) {
    args.push('--dry-run');
  }

  const { stdout, stderr } = await runCommand(MASTER_PIPELINE_PYTHON_PATH, args);
  await fsPromises.writeFile(planeLayoutLogPath, [stdout.trim(), stderr.trim()].filter(Boolean).join('\n\n'));

  const summaryPath = path.join(planeLayoutDir, 'summary.json');
  const summary = await readJsonFile(summaryPath);

  return {
    summary,
    summaryPath,
    layoutPath: path.join(planeLayoutDir, 'layout.json'),
    logPath: planeLayoutLogPath,
  };
}

async function runOpeningDetection(job) {
  const openingDetectionDir = getOpeningDetectionDir(job.id);
  const openingDetectionLogPath = path.join(getLogsDir(job.id), 'opening_detection.log');

  await fsPromises.rm(openingDetectionDir, { recursive: true, force: true });
  await fsPromises.mkdir(path.join(openingDetectionDir, 'debug'), { recursive: true });

  const args = [
    MASTER_PIPELINE_OPENING_DETECTION_SCRIPT_PATH,
    '--job-id', job.id,
    '--dense-evidence-dir', getDenseEvidenceDir(job.id),
    '--layout-path', path.join(getPlaneLayoutDir(job.id), 'layout.json'),
    '--output-dir', openingDetectionDir,
  ];

  if (MASTER_PIPELINE_OPENING_DETECTION_DRY_RUN) {
    args.push('--dry-run');
  }

  const { stdout, stderr } = await runCommand(MASTER_PIPELINE_PYTHON_PATH, args);
  await fsPromises.writeFile(openingDetectionLogPath, [stdout.trim(), stderr.trim()].filter(Boolean).join('\n\n'));

  const summaryPath = path.join(openingDetectionDir, 'summary.json');
  const summary = await readJsonFile(summaryPath);

  return {
    summary,
    summaryPath,
    candidatesPath: path.join(openingDetectionDir, 'candidates.json'),
    debugDir: path.join(openingDetectionDir, 'debug'),
    logPath: openingDetectionLogPath,
  };
}

async function runMeshAuthoring(job) {
  const meshAuthoringDir = getMeshAuthoringDir(job.id);
  const meshAuthoringLogPath = path.join(getLogsDir(job.id), 'mesh_authoring.log');

  await fsPromises.rm(meshAuthoringDir, { recursive: true, force: true });
  await fsPromises.mkdir(meshAuthoringDir, { recursive: true });

  const args = [
    MASTER_PIPELINE_MESH_AUTHORING_SCRIPT_PATH,
    '--job-id', job.id,
    '--layout-path', path.join(getPlaneLayoutDir(job.id), 'layout.json'),
    '--openings-path', path.join(getOpeningDetectionDir(job.id), 'candidates.json'),
    '--dense-evidence-dir', getDenseEvidenceDir(job.id),
    '--output-dir', meshAuthoringDir,
  ];

  if (MASTER_PIPELINE_MESH_AUTHORING_DRY_RUN) {
    args.push('--dry-run');
  }

  const { stdout, stderr } = await runCommand(MASTER_PIPELINE_PYTHON_PATH, args);
  await fsPromises.writeFile(meshAuthoringLogPath, [stdout.trim(), stderr.trim()].filter(Boolean).join('\n\n'));

  const summaryPath = path.join(meshAuthoringDir, 'summary.json');
  const summary = await readJsonFile(summaryPath);

  return {
    summary,
    summaryPath,
    shellMeshPath: path.join(meshAuthoringDir, 'shell_mesh.obj'),
    shellMeshPlyPath: path.join(meshAuthoringDir, 'shell_mesh.ply'),
    panelBreakdownPath: path.join(meshAuthoringDir, 'panel_breakdown.json'),
    detailMeshSummaryPath: summary.detailMesh ? path.join(meshAuthoringDir, 'detail_mesh', 'summary.json') : null,
    logPath: meshAuthoringLogPath,
  };
}

async function runUvInitialBake(job) {
  const uvInitialBakeDir = getUvInitialBakeDir(job.id);
  const uvInitialBakeLogPath = path.join(getLogsDir(job.id), 'uv_initial_bake.log');

  await fsPromises.rm(uvInitialBakeDir, { recursive: true, force: true });
  await fsPromises.mkdir(uvInitialBakeDir, { recursive: true });

  if (!job.capture.selectedFramesDir) {
    throw new Error('master_uv_initial_bake_selected_frames_missing');
  }

  const args = [
    MASTER_PIPELINE_UV_INITIAL_BAKE_SCRIPT_PATH,
    '--job-id', job.id,
    '--images-dir', job.capture.selectedFramesDir,
    '--sfm-sparse-model-dir', path.join(getSfmDir(job.id), 'sparse'),
    '--shell-mesh-path', path.join(getMeshAuthoringDir(job.id), 'shell_mesh.obj'),
    '--output-dir', uvInitialBakeDir,
  ];

  if (MASTER_PIPELINE_UV_INITIAL_BAKE_DRY_RUN) {
    args.push('--dry-run');
  }

  const { stdout, stderr } = await runCommand(MASTER_PIPELINE_PYTHON_PATH, args);
  await fsPromises.writeFile(uvInitialBakeLogPath, [stdout.trim(), stderr.trim()].filter(Boolean).join('\n\n'));

  const summaryPath = path.join(uvInitialBakeDir, 'summary.json');
  const summary = await readJsonFile(summaryPath);

  return {
    summary,
    summaryPath,
    logPath: uvInitialBakeLogPath,
  };
}

async function runAppearanceRefinement(job) {
  const appearanceDir = getAppearanceDir(job.id);
  const appearanceLogPath = path.join(getLogsDir(job.id), 'appearance_refinement.log');

  await fsPromises.rm(appearanceDir, { recursive: true, force: true });
  await fsPromises.mkdir(appearanceDir, { recursive: true });

  if (!job.capture.selectedFramesDir) {
    throw new Error('master_appearance_selected_frames_missing');
  }

  const args = [
    MASTER_PIPELINE_APPEARANCE_REFINEMENT_SCRIPT_PATH,
    '--job-id', job.id,
    '--images-dir', job.capture.selectedFramesDir,
    '--sfm-text-model-dir', path.join(getSfmDir(job.id), 'text-model'),
    '--uv-bake-dir', getUvInitialBakeDir(job.id),
    '--mesh-authoring-dir', getMeshAuthoringDir(job.id),
    '--output-dir', appearanceDir,
  ];

  if (MASTER_PIPELINE_APPEARANCE_REFINEMENT_DRY_RUN) {
    args.push('--dry-run');
  }

  const { stdout, stderr } = await runCommand(MASTER_PIPELINE_PYTHON_PATH, args);
  await fsPromises.writeFile(appearanceLogPath, [stdout.trim(), stderr.trim()].filter(Boolean).join('\n\n'));

  const summaryPath = path.join(appearanceDir, 'summary.json');
  const summary = await readJsonFile(summaryPath);

  return {
    summary,
    summaryPath,
    logPath: appearanceLogPath,
  };
}

async function runExportQa(job) {
  const exportQaDir = getExportQaDir(job.id);
  const exportQaLogPath = path.join(getLogsDir(job.id), 'export_qa.log');

  await fsPromises.rm(exportQaDir, { recursive: true, force: true });
  await fsPromises.mkdir(exportQaDir, { recursive: true });

  const args = [
    MASTER_PIPELINE_EXPORT_QA_SCRIPT_PATH,
    '--job-id', job.id,
    '--appearance-dir', getAppearanceDir(job.id),
    '--output-dir', exportQaDir,
  ];

  const { stdout, stderr } = await runCommand(MASTER_PIPELINE_PYTHON_PATH, args);
  await fsPromises.writeFile(exportQaLogPath, [stdout.trim(), stderr.trim()].filter(Boolean).join('\n\n'));

  const summaryPath = path.join(exportQaDir, 'summary.json');
  const summary = await readJsonFile(summaryPath);

  return {
    summary,
    summaryPath,
    logPath: exportQaLogPath,
  };
}

function getRemoteWorkerStatusArtifactPath(jobId) {
  return path.join('outputs', 'master_pipeline_remote_status.json');
}

function getRemoteWorkerResultArtifactPath(jobId) {
  return path.join('outputs', 'master_pipeline_remote_result.json');
}

function getRemoteWorkerResultPath(jobId) {
  return path.join(getJobOutputsDir(jobId), 'master_pipeline_remote_result.json');
}

async function syncRemoteWorkerStageState(jobId, currentStageId, completedStageIds = [], activeStageIds = []) {
  const completedSet = new Set(completedStageIds.map((stageId) => normalizeRemoteStageId(stageId)));
  const normalizedActiveStageIds = Array.isArray(activeStageIds) && activeStageIds.length
    ? activeStageIds.map((stageId) => normalizeRemoteStageId(stageId))
    : [normalizeRemoteStageId(currentStageId)].filter(Boolean);
  const activeSet = new Set(normalizedActiveStageIds);
  const primaryActiveStageId = MASTER_PIPELINE_REMOTE_STAGE_IDS.find((stageId) => activeSet.has(stageId)) || normalizeRemoteStageId(currentStageId);

  await mutateJob(jobId, async (job) => {
    job.updatedAt = nowIso();
    if (MASTER_PIPELINE_RUNNING_STATUS_BY_STAGE[primaryActiveStageId]) {
      job.status = MASTER_PIPELINE_RUNNING_STATUS_BY_STAGE[primaryActiveStageId];
    }

    for (const stageId of MASTER_PIPELINE_REMOTE_STAGE_IDS) {
      if (completedSet.has(stageId)) {
        job = updateStage(job, stageId, 'completed');
        continue;
      }

      if (activeSet.has(stageId)) {
        job = updateStage(job, stageId, 'running');
        continue;
      }

      const stage = job.stages.find((entry) => entry.id === stageId);
      if (stage && stage.status === 'pending') {
        job = updateStage(job, stageId, 'queued');
      }
    }

    return job;
  });
}

async function collectRemoteWorkerStageResults(jobId, options = {}) {
  const gaussianOnly = options.gaussianOnly === true;
  const metric3dMeshOnly = options.metric3dMeshOnly === true;
  const remoteResult = await readJsonFileIfPresent(getRemoteWorkerResultPath(jobId));
  const hasMeshOutput = metric3dMeshOnly
    || remoteResult?.metric3dMeshOnly === true
    || remoteResult?.metric3dMeshSidecar === true
    || remoteResult?.finalSummaryPath;
  const depthPriorArtifacts = await resolveRemoteDepthPriorArtifacts(jobId);

  const metric3dSummary = depthPriorArtifacts.summary;
  const learnedMatchingSummary = await readJsonFile(path.join(getLearnedMatchingDir(jobId), 'summary.json'));
  const globalSfmSummary = await readJsonFile(path.join(getSfmDir(jobId), 'summary.json'));
  const denseEvidenceSummary = gaussianOnly && !hasMeshOutput
    ? null
    : await readJsonFile(path.join(getDenseEvidenceDir(jobId), 'summary.json'));
  const gaussianSummary = metric3dMeshOnly || remoteResult?.metric3dMeshOnly === true
    ? null
    : await readJsonFileIfPresent(path.join(getGaussianSplattingDir(jobId), 'summary.json'));
  const planeLayoutSummary = gaussianOnly && !hasMeshOutput
    ? null
    : await readJsonFile(path.join(getPlaneLayoutDir(jobId), 'summary.json'));
  const openingDetectionSummary = gaussianOnly && !hasMeshOutput
    ? null
    : await readJsonFile(path.join(getOpeningDetectionDir(jobId), 'summary.json'));
  const meshAuthoringSummary = gaussianOnly && !hasMeshOutput
    ? null
    : await readJsonFile(path.join(getMeshAuthoringDir(jobId), 'summary.json'));
  const uvInitialBakeSummary = gaussianOnly && !hasMeshOutput
    ? null
    : await readJsonFile(path.join(getUvInitialBakeDir(jobId), 'summary.json'));
  const appearanceRefinementSummary = gaussianOnly && !hasMeshOutput
    ? null
    : await readJsonFile(path.join(getAppearanceDir(jobId), 'summary.json'));
  const exportQaSummary = gaussianOnly && !hasMeshOutput
    ? null
    : await readJsonFile(path.join(getExportQaDir(jobId), 'summary.json'));

  return {
    metric3dResult: {
      summary: metric3dSummary,
      stageId: depthPriorArtifacts.stageId,
      artifactSubdir: depthPriorArtifacts.artifactSubdir,
      logPath: path.join(getLogsDir(jobId), `${depthPriorArtifacts.stageId}.log`),
    },
    learnedMatchingResult: {
      summary: learnedMatchingSummary,
      logPath: path.join(getLogsDir(jobId), 'learned_matching.log'),
    },
    globalSfmResult: {
      summary: globalSfmSummary,
      logPath: path.join(getLogsDir(jobId), 'global_sfm.log'),
    },
    denseEvidenceResult: {
      summary: denseEvidenceSummary,
      logPath: path.join(getLogsDir(jobId), 'dense_evidence.log'),
    },
    gaussianResult: {
      summary: gaussianSummary,
      logPath: path.join(getLogsDir(jobId), 'gaussian_splatting.log'),
    },
    planeLayoutResult: {
      summary: planeLayoutSummary,
      logPath: path.join(getLogsDir(jobId), 'plane_layout.log'),
    },
    openingDetectionResult: {
      summary: openingDetectionSummary,
      logPath: path.join(getLogsDir(jobId), 'opening_detection.log'),
    },
    meshAuthoringResult: {
      summary: meshAuthoringSummary,
      detailMeshSummaryPath: meshAuthoringSummary?.detailMesh
        ? path.join(getMeshAuthoringDir(jobId), 'detail_mesh', 'summary.json')
        : null,
      logPath: path.join(getLogsDir(jobId), 'mesh_authoring.log'),
    },
    uvInitialBakeResult: {
      summary: uvInitialBakeSummary,
      logPath: path.join(getLogsDir(jobId), 'uv_initial_bake.log'),
    },
    appearanceRefinementResult: {
      summary: appearanceRefinementSummary,
      logPath: path.join(getLogsDir(jobId), 'appearance_refinement.log'),
    },
    exportQaResult: {
      summary: exportQaSummary,
      logPath: path.join(getLogsDir(jobId), 'export_qa.log'),
    },
  };
}

async function finalizeRemoteWorkerSuccess(jobId, options = {}) {
  const gaussianOnly = options.gaussianOnly === true;
  const metric3dMeshOnly = options.metric3dMeshOnly === true;

  const {
    metric3dResult,
    learnedMatchingResult,
    globalSfmResult,
    denseEvidenceResult,
    gaussianResult,
    planeLayoutResult,
    openingDetectionResult,
    meshAuthoringResult,
    uvInitialBakeResult,
    appearanceRefinementResult,
    exportQaResult,
  } = await collectRemoteWorkerStageResults(jobId, { gaussianOnly, metric3dMeshOnly });
  const depthPriorArtifactUrls = metric3dResult.summary
    ? buildDepthPriorArtifactUrls(jobId, metric3dResult.artifactSubdir)
    : {
        summaryPath: null,
        depthDir: null,
        normalsDir: null,
        confidenceDir: null,
        previewDir: null,
      };

  return mutateJob(jobId, async (currentJob) => {
    currentJob.updatedAt = nowIso();
    currentJob.status = 'completed';
    currentJob.outputs.depthPriorStageId = metric3dResult.stageId;
    currentJob.outputs.depthPriorsSummaryPath = depthPriorArtifactUrls.summaryPath;
    currentJob.outputs.depthPriorsDepthDir = depthPriorArtifactUrls.depthDir;
    currentJob.outputs.depthPriorsNormalsDir = depthPriorArtifactUrls.normalsDir;
    currentJob.outputs.depthPriorsConfidenceDir = depthPriorArtifactUrls.confidenceDir;
    currentJob.outputs.depthPriorsPreviewDir = depthPriorArtifactUrls.previewDir;
    currentJob.outputs.metric3dSummaryPath = depthPriorArtifactUrls.summaryPath;
    currentJob.outputs.metric3dDepthDir = depthPriorArtifactUrls.depthDir;
    currentJob.outputs.metric3dNormalsDir = depthPriorArtifactUrls.normalsDir;
    currentJob.outputs.metric3dConfidenceDir = depthPriorArtifactUrls.confidenceDir;
    currentJob.outputs.metric3dPreviewDir = depthPriorArtifactUrls.previewDir;
    currentJob.outputs.learnedMatchingSummaryPath = getArtifactUrl(jobId, path.join('priors', 'learned_matching', 'summary.json'));
    currentJob.outputs.learnedMatchingMatchGraphPath = getArtifactUrl(jobId, path.join('priors', 'learned_matching', 'match_graph.json'));
    currentJob.outputs.learnedMatchingFeatureStorePath = getArtifactUrl(jobId, path.join('priors', 'learned_matching', 'feature_store.json'));
    currentJob.outputs.learnedMatchingMatchesStorePath = getArtifactUrl(jobId, path.join('priors', 'learned_matching', 'matches_store.json'));
    currentJob.outputs.learnedMatchingTrackStorePath = getArtifactUrl(jobId, path.join('priors', 'learned_matching', 'track_store.json'));
    currentJob.outputs.learnedMatchingPairsDir = getArtifactUrl(jobId, path.join('priors', 'learned_matching', 'pairs'));
    currentJob.outputs.learnedMatchingPreviewDir = getArtifactUrl(jobId, path.join('priors', 'learned_matching', 'previews'));
    currentJob.outputs.globalSfmSummaryPath = getArtifactUrl(jobId, path.join('sfm', 'global_sfm', 'summary.json'));
    currentJob.outputs.globalSfmDatabasePath = getArtifactUrl(jobId, path.join('sfm', 'global_sfm', 'database.db'));
    currentJob.outputs.globalSfmSparseModelDir = getArtifactUrl(jobId, path.join('sfm', 'global_sfm', 'sparse'));
    currentJob.outputs.globalSfmTextModelDir = getArtifactUrl(jobId, path.join('sfm', 'global_sfm', 'text-model'));
    currentJob.outputs.globalSfmCamerasPath = getArtifactUrl(jobId, path.join('sfm', 'global_sfm', 'text-model', 'cameras.txt'));
    currentJob.outputs.globalSfmImagesPath = getArtifactUrl(jobId, path.join('sfm', 'global_sfm', 'text-model', 'images.txt'));
    currentJob.outputs.globalSfmPointsPath = getArtifactUrl(jobId, path.join('sfm', 'global_sfm', 'text-model', 'points3D.txt'));
    currentJob.outputs.fast3rPointmapTailRescueSummaryPath = getArtifactUrl(jobId, path.join('sfm', 'global_sfm', 'fast3r_pointmap_tail_rescue', 'summary.json'));
    currentJob.outputs.fast3rPointmapTailRescueTextModelDir = getArtifactUrl(jobId, path.join('sfm', 'global_sfm', 'fast3r_pointmap_tail_rescue', 'text-model'));
    currentJob.outputs.fast3rPointmapTailRescueImagesPath = getArtifactUrl(jobId, path.join('sfm', 'global_sfm', 'fast3r_pointmap_tail_rescue', 'text-model', 'images.txt'));
    currentJob.outputs.fast3rPointmapTailRescuePointsPath = getArtifactUrl(jobId, path.join('sfm', 'global_sfm', 'fast3r_pointmap_tail_rescue', 'text-model', 'points3D.txt'));
    currentJob.outputs.fast3rPointmapTailRescuePosesPath = getArtifactUrl(jobId, path.join('sfm', 'global_sfm', 'fast3r_pointmap_tail_rescue', 'poses.json'));
    currentJob.outputs.experimentalMultiviewSummaryPath = getArtifactUrl(jobId, path.join('sfm', 'global_sfm', 'experimental_multiview', 'summary.json'));
    currentJob.outputs.experimentalMultiviewBundlePath = getArtifactUrl(jobId, path.join('sfm', 'global_sfm', 'experimental_multiview', 'bundle.npz'));
    currentJob.outputs.experimentalMultiviewCameraGraphPath = getArtifactUrl(jobId, path.join('sfm', 'global_sfm', 'experimental_multiview', 'camera_graph.json'));
    currentJob.outputs.experimentalMultiviewPoseGraphPath = getArtifactUrl(jobId, path.join('sfm', 'global_sfm', 'experimental_multiview', 'pose_graph.json'));
    currentJob.outputs.denseEvidenceSummaryPath = getArtifactUrl(jobId, path.join('dense_evidence', 'summary.json'));
    currentJob.outputs.denseEvidencePointCloudPath = getArtifactUrl(jobId, path.join('dense_evidence', 'fused_scene.ply'));
    currentJob.outputs.denseEvidencePointsPath = getArtifactUrl(jobId, path.join('dense_evidence', 'points.npy'));
    currentJob.outputs.denseEvidenceColorsPath = getArtifactUrl(jobId, path.join('dense_evidence', 'colors.npy'));
    currentJob.outputs.gaussianSummaryPath = gaussianResult.summary
      ? getArtifactUrl(jobId, path.join('gaussian', 'splatting', 'summary.json'))
      : null;
    currentJob.outputs.gaussianScenePath = getArtifactUrlForAbsolutePath(jobId, gaussianResult.summary?.splatScenePath || null);
    currentJob.outputs.gaussianPlyPath = getArtifactUrlForAbsolutePath(jobId, gaussianResult.summary?.splatPlyPath || null);
    currentJob.outputs.gaussianViewerPath = getArtifactUrlForAbsolutePath(jobId, gaussianResult.summary?.viewerHtmlPath || null);
    currentJob.outputs.refGaussianSummaryPath = gaussianResult.summary?.refGaussian?.applied
      ? getArtifactUrlForAbsolutePath(jobId, gaussianResult.summary?.refGaussian?.resultPath || null)
      : null;
    currentJob.outputs.refGaussianScenePath = getArtifactUrlForAbsolutePath(jobId, gaussianResult.summary?.refGaussian?.splatScenePath || null);
    currentJob.outputs.refGaussianPlyPath = getArtifactUrlForAbsolutePath(jobId, gaussianResult.summary?.refGaussian?.splatPlyPath || null);
    currentJob.outputs.refGaussianViewerPath = getArtifactUrlForAbsolutePath(jobId, gaussianResult.summary?.refGaussian?.viewerHtmlPath || null);
    currentJob.outputs.refGaussianNativeRenderContractPath = getArtifactUrlForAbsolutePath(jobId, gaussianResult.summary?.refGaussian?.nativeRenderContractPath || null);
    currentJob.outputs.refGaussianNativeRenderContractManifestPath = getArtifactUrlForAbsolutePath(jobId, gaussianResult.summary?.refGaussian?.nativeRenderContractManifestPath || null);
    currentJob.outputs.planeLayoutSummaryPath = planeLayoutResult.summary
      ? getArtifactUrl(jobId, path.join('layout', 'plane_layout', 'summary.json'))
      : null;
    currentJob.outputs.planeLayoutPath = planeLayoutResult.summary
      ? getArtifactUrl(jobId, path.join('layout', 'plane_layout', 'layout.json'))
      : null;
    currentJob.outputs.openingDetectionSummaryPath = openingDetectionResult.summary
      ? getArtifactUrl(jobId, path.join('layout', 'opening_detection', 'summary.json'))
      : null;
    currentJob.outputs.openingCandidatesPath = openingDetectionResult.summary
      ? getArtifactUrl(jobId, path.join('layout', 'opening_detection', 'candidates.json'))
      : null;
    currentJob.outputs.openingDebugDir = openingDetectionResult.summary
      ? getArtifactUrl(jobId, path.join('layout', 'opening_detection', 'debug'))
      : null;
    currentJob.outputs.meshAuthoringSummaryPath = meshAuthoringResult.summary
      ? getArtifactUrl(jobId, path.join('mesh', 'authoring', 'summary.json'))
      : null;
    currentJob.outputs.shellMeshPath = meshAuthoringResult.summary
      ? getArtifactUrl(jobId, path.join('mesh', 'authoring', 'shell_mesh.obj'))
      : null;
    currentJob.outputs.shellMeshPlyPath = meshAuthoringResult.summary
      ? getArtifactUrl(jobId, path.join('mesh', 'authoring', 'shell_mesh.ply'))
      : null;
    currentJob.outputs.meshPanelBreakdownPath = meshAuthoringResult.summary
      ? getArtifactUrl(jobId, path.join('mesh', 'authoring', 'panel_breakdown.json'))
      : null;
    currentJob.outputs.detailMeshSummaryPath = meshAuthoringResult.summary?.detailMesh
      ? getArtifactUrl(jobId, path.join('mesh', 'authoring', 'detail_mesh', 'summary.json'))
      : null;
    currentJob.outputs.uvInitialBakeSummaryPath = uvInitialBakeResult.summary
      ? getArtifactUrl(jobId, path.join('texture', 'uv_initial_bake', 'summary.json'))
      : null;
    currentJob.outputs.uvTexturedMeshPath = getArtifactUrlForAbsolutePath(jobId, uvInitialBakeResult.summary?.texturedMeshPath || null);
    currentJob.outputs.uvTexturePath = getArtifactUrlForAbsolutePath(jobId, uvInitialBakeResult.summary?.texturePath || null);
    currentJob.outputs.appearanceSummaryPath = appearanceRefinementResult.summary
      ? getArtifactUrl(jobId, path.join('appearance', 'refinement', 'summary.json'))
      : null;
    currentJob.outputs.refinedMeshPath = getArtifactUrlForAbsolutePath(jobId, appearanceRefinementResult.summary?.refinedMeshPath || null);
    currentJob.outputs.refinedTexturePath = getArtifactUrlForAbsolutePath(jobId, appearanceRefinementResult.summary?.refinedTexturePath || null);
    currentJob.outputs.exportSummaryPath = exportQaResult.summary
      ? getArtifactUrl(jobId, path.join('export', 'qa', 'summary.json'))
      : null;
    currentJob.outputs.finalGlbPath = getArtifactUrlForAbsolutePath(jobId, exportQaResult.summary?.finalGlbPath || null);
    currentJob.outputs.optimizedGlbPath = getArtifactUrlForAbsolutePath(jobId, exportQaResult.summary?.optimizedGlbPath || null);
    currentJob.outputs.qaReportPath = getArtifactUrlForAbsolutePath(jobId, exportQaResult.summary?.qaReportPath || null);
    currentJob.outputs.remoteWorkerStatusPath = getArtifactUrl(jobId, getRemoteWorkerStatusArtifactPath(jobId));
    currentJob.outputs.remoteWorkerResultPath = getArtifactUrl(jobId, getRemoteWorkerResultArtifactPath(jobId));
    currentJob.metadata = {
      ...currentJob.metadata,
      depthPriorStageId: metric3dResult.stageId,
      depthPriorsSummary: metric3dResult.summary,
      metric3dSummary: metric3dResult.summary,
      learnedMatchingSummary: learnedMatchingResult.summary,
      globalSfmSummary: globalSfmResult.summary,
      denseEvidenceSummary: denseEvidenceResult.summary,
      gaussianSplattingSummary: gaussianResult.summary,
      planeLayoutSummary: planeLayoutResult.summary,
      openingDetectionSummary: openingDetectionResult.summary,
      meshAuthoringSummary: meshAuthoringResult.summary,
      uvInitialBakeSummary: uvInitialBakeResult.summary,
      appearanceRefinementSummary: appearanceRefinementResult.summary,
      exportQaSummary: exportQaResult.summary,
      completedAt: nowIso(),
      remoteWorkerMode: 'master_v1_gcp_worker',
    };

    for (const stageId of MASTER_PIPELINE_REMOTE_STAGE_IDS) {
      currentJob = updateStage(currentJob, stageId, 'completed');
    }

    return currentJob;
  });
}

async function setJobFailure(jobId, error, failedStageId) {
  const normalizedFailedStageId = normalizeRemoteStageId(failedStageId);
  const errorReport = {
    jobId,
    failedAt: nowIso(),
    failedStage: normalizedFailedStageId,
    error: normalizeError(error),
    note: 'master_v1 is fail-fast for required stages. The job stopped at the stage listed above and preserved all prior artifacts for diagnosis.',
  };

  await fsPromises.mkdir(getJobDir(jobId), { recursive: true });
  await fsPromises.writeFile(getJobErrorReportPath(jobId), JSON.stringify(errorReport, null, 2));

  return mutateJob(jobId, async (job) => {
    job.updatedAt = nowIso();
    job.status = 'failed';
    job.metadata = {
      ...job.metadata,
      failedStage: normalizedFailedStageId,
      lastError: normalizeError(error),
    };
    if (normalizedFailedStageId) {
      job = updateStage(job, normalizedFailedStageId, 'failed');
    }
    return job;
  });
}

async function finalizeRoomScanMirror(jobId) {
  const completedJob = await loadJob(jobId);
  const { roomScanId, roomScanData } = await mirrorMasterJobToRoomScanner(completedJob);

  await mutateJob(jobId, async (currentJob) => {
    currentJob.updatedAt = nowIso();
    currentJob.metadata = {
      ...currentJob.metadata,
      roomScanId,
      roomScanModelViewerUrl: roomScanData?.metadata?.modelViewerUrl || null,
      roomScanPrimaryOutput: roomScanData?.metadata?.primaryOutput || null,
      roomScanMirrorStatus: 'completed',
      roomScanMirroredAt: nowIso(),
    };
    return currentJob;
  });
}

async function runMasterJob(jobId) {
  let activeStageId = 'frame_qc';

  try {
    await mutateJob(jobId, async (job) => {
      job.updatedAt = nowIso();
      job.status = 'running_frame_qc';
      job = updateStage(job, 'ingest', 'completed');
      job = updateStage(job, 'frame_qc', 'running');
      job = updateStage(job, 'camera_calibration', 'queued');
      return job;
    });

    let job = await loadJob(jobId);
    const frameQcResult = await prepareFramesAndQc(job);

    activeStageId = 'camera_calibration';
    await mutateJob(jobId, async (currentJob) => {
      currentJob.updatedAt = nowIso();
      currentJob.status = 'running_calibration';
      currentJob.capture.rawFrameCount = frameQcResult.rawFrameCount;
      currentJob.capture.selectedFrameCount = frameQcResult.selectedFrameCount;
      currentJob.capture.rejectedFrameCount = frameQcResult.rejectedFrameCount;
      currentJob.capture.selectedFramesDir = frameQcResult.selectedFramesDir;
      currentJob.outputs.frameQcManifestPath = getArtifactUrl(jobId, path.join('frames', 'frame_qc.json'));
      currentJob.outputs.selectedContactSheetPath = getArtifactUrl(jobId, path.join('frames', 'contact_sheet_selected.jpg'));
      currentJob.outputs.rejectedContactSheetPath = getArtifactUrl(jobId, path.join('frames', 'contact_sheet_rejected.jpg'));
      currentJob = updateStage(currentJob, 'frame_qc', 'completed');
      currentJob = updateStage(currentJob, 'camera_calibration', 'running');
      return currentJob;
    });

    job = await loadJob(jobId);
    const calibrationResult = await runCalibration(job, frameQcResult);

    job = await mutateJob(jobId, async (currentJob) => {
      currentJob.updatedAt = nowIso();
      currentJob.status = 'running_metric3d';
      currentJob.scale = {
        ...currentJob.scale,
        ...calibrationResult.scale,
      };
      currentJob.outputs.intrinsicsPath = getArtifactUrl(jobId, path.join('calibration', 'intrinsics.json'));
      currentJob.outputs.distortionPath = getArtifactUrl(jobId, path.join('calibration', 'distortion.json'));
      currentJob.outputs.scalePath = getArtifactUrl(jobId, path.join('calibration', 'scale.json'));
      currentJob.outputs.cameraReportPath = getArtifactUrl(jobId, path.join('calibration', 'camera_report.json'));
      currentJob.outputs.executionPlanPath = getArtifactUrl(jobId, path.join('outputs', 'master-execution-plan.json'));
      currentJob = updateStage(currentJob, 'camera_calibration', 'completed');
      currentJob = updateStage(currentJob, 'metric3d_priors', 'running');
      return currentJob;
    });

    activeStageId = 'metric3d_priors';
    job = await loadJob(jobId);
    const requestedInputOptions = job.requestedProcessing?.inputOptions || {};
    const gaussianViewerPreset = resolveRequestedGaussianViewerPreset(
      requestedInputOptions,
      MASTER_PIPELINE_REMOTE_GAUSSIAN_VIEWER_PRESET,
    );

    const masterPipelineWorker = getMasterPipelineGcpWorker();
    if (masterPipelineWorker.enabled) {
      try {
        const hasExplicitLearnedMatchingPreset = Object.prototype.hasOwnProperty.call(
          requestedInputOptions,
          'learnedMatchingPreset',
        ) && Boolean(requestedInputOptions.learnedMatchingPreset);
        await masterPipelineWorker.processPipeline(
          getJobDir(jobId),
          {
            jobId,
            metric3dModelSize: requestedInputOptions.metric3dModelSize || MASTER_PIPELINE_METRIC3D_MODEL_SIZE,
            metric3dGpuIndices: MASTER_PIPELINE_METRIC3D_GPU_INDICES,
            gaussianViewerPreset,
            learnedMatchingPreset: requestedInputOptions.learnedMatchingPreset || resolveDefaultLearnedMatchingPresetForViewerPreset(gaussianViewerPreset),
            learnedMatchingPresetExplicit: hasExplicitLearnedMatchingPreset,
            learnedMatchingImageSize: requestedInputOptions.learnedMatchingImageSize || MASTER_PIPELINE_REMOTE_LEARNED_MATCHING_IMAGE_SIZE,
            learnedMatchingGpuIndices: MASTER_PIPELINE_LEARNED_MATCHING_GPU_INDICES,
            denseStereoGpuIndices: MASTER_PIPELINE_DENSE_STEREO_GPU_INDICES,
            metric3dDryRun: MASTER_PIPELINE_METRIC3D_DRY_RUN,
            learnedMatchingDryRun: MASTER_PIPELINE_LEARNED_MATCHING_DRY_RUN,
            globalSfmDryRun: MASTER_PIPELINE_GLOBAL_SFM_DRY_RUN,
            denseEvidenceDryRun: MASTER_PIPELINE_DENSE_EVIDENCE_DRY_RUN,
            gaussianSplattingDryRun: MASTER_PIPELINE_GAUSSIAN_SPLATTING_DRY_RUN,
            planeLayoutDryRun: MASTER_PIPELINE_PLANE_LAYOUT_DRY_RUN,
            openingDetectionDryRun: MASTER_PIPELINE_OPENING_DETECTION_DRY_RUN,
            meshAuthoringDryRun: MASTER_PIPELINE_MESH_AUTHORING_DRY_RUN,
            uvInitialBakeDryRun: MASTER_PIPELINE_UV_INITIAL_BAKE_DRY_RUN,
            appearanceRefinementDryRun: MASTER_PIPELINE_APPEARANCE_REFINEMENT_DRY_RUN,
            efficientLoftrRequired: Boolean(requestedInputOptions.efficientLoftrRequired),
            gaussianOnly: Boolean(requestedInputOptions.gaussianOnly),
            requireGaussianSplatting: Boolean(requestedInputOptions.requireGaussianSplatting),
            gsplatIterations: requestedInputOptions.gsplatIterations,
            gaussianMaxInitPoints: requestedInputOptions.gaussianMaxInitPoints,
            gaussianDepthPriorsMaxPointsPerImage: requestedInputOptions.gaussianDepthPriorsMaxPointsPerImage,
            mirrorGaussianCommand: requestedInputOptions.mirrorGaussianCommand,
            requireMirrorGaussian: Boolean(requestedInputOptions.requireMirrorGaussian),
            refGaussianCommand: requestedInputOptions.refGaussianCommand,
            requireRefGaussian: Boolean(requestedInputOptions.requireRefGaussian),
            refGaussianProfileMode: requestedInputOptions.refGaussianProfileMode,
            refGaussianOnly: Boolean(requestedInputOptions.refGaussianOnly),
            scaffoldGsCommand: requestedInputOptions.scaffoldGsCommand,
            requireScaffoldGs: Boolean(requestedInputOptions.requireScaffoldGs),
            scaffoldGsOnly: Boolean(requestedInputOptions.scaffoldGsOnly),
            metric3dMeshSidecar: Boolean(requestedInputOptions.metric3dMeshSidecar),
            metric3dMeshOnly: Boolean(requestedInputOptions.metric3dMeshOnly),
          },
          async (status) => {
            if (status?.currentStage || (Array.isArray(status?.activeStages) && status.activeStages.length)) {
              activeStageId = normalizeRemoteStageId(status.currentStage)
                || MASTER_PIPELINE_REMOTE_STAGE_IDS.find((stageId) => status.activeStages.includes(stageId))
                || activeStageId;
              await syncRemoteWorkerStageState(jobId, status.currentStage, status.completedStages || [], status.activeStages || []);
            }
          },
        );
      } catch (error) {
        if (error?.failedStageId) {
          activeStageId = normalizeRemoteStageId(error.failedStageId);
        }
        throw error;
      }

      await finalizeRemoteWorkerSuccess(jobId, {
        gaussianOnly: Boolean(requestedInputOptions.gaussianOnly),
        metric3dMeshSidecar: Boolean(requestedInputOptions.metric3dMeshSidecar),
        metric3dMeshOnly: Boolean(requestedInputOptions.metric3dMeshOnly),
      });
      job = await loadJob(jobId);
      await writeExecutionContract(job, job.requestedProcessing?.inputOptions || {});
      await finalizeRoomScanMirror(jobId);
      return;
    }

    const metric3dResult = await runMetric3dPriors(job);

    job = await mutateJob(jobId, async (currentJob) => {
      currentJob.updatedAt = nowIso();
      currentJob.status = 'running_learned_matching';
      currentJob.outputs.metric3dSummaryPath = getArtifactUrl(jobId, path.join('priors', 'metric3d', 'summary.json'));
      currentJob.outputs.metric3dDepthDir = getArtifactUrl(jobId, path.join('priors', 'metric3d', 'depth'));
      currentJob.outputs.metric3dNormalsDir = getArtifactUrl(jobId, path.join('priors', 'metric3d', 'normals'));
      currentJob.outputs.metric3dConfidenceDir = getArtifactUrl(jobId, path.join('priors', 'metric3d', 'confidence'));
      currentJob.outputs.metric3dPreviewDir = getArtifactUrl(jobId, path.join('priors', 'metric3d', 'previews'));
      currentJob.metadata = {
        ...currentJob.metadata,
        metric3dSummary: metric3dResult.summary,
      };
      currentJob = updateStage(currentJob, 'metric3d_priors', 'completed');
      currentJob = updateStage(currentJob, 'learned_matching', 'running');
      return currentJob;
    });

    activeStageId = 'learned_matching';
    job = await loadJob(jobId);
    const learnedMatchingResult = await runLearnedMatching(job);

    job = await mutateJob(jobId, async (currentJob) => {
      currentJob.updatedAt = nowIso();
      currentJob.status = 'running_global_sfm';
      currentJob.outputs.learnedMatchingSummaryPath = getArtifactUrl(jobId, path.join('priors', 'learned_matching', 'summary.json'));
      currentJob.outputs.learnedMatchingMatchGraphPath = getArtifactUrl(jobId, path.join('priors', 'learned_matching', 'match_graph.json'));
      currentJob.outputs.learnedMatchingFeatureStorePath = getArtifactUrl(jobId, path.join('priors', 'learned_matching', 'feature_store.json'));
      currentJob.outputs.learnedMatchingMatchesStorePath = getArtifactUrl(jobId, path.join('priors', 'learned_matching', 'matches_store.json'));
      currentJob.outputs.learnedMatchingTrackStorePath = getArtifactUrl(jobId, path.join('priors', 'learned_matching', 'track_store.json'));
      currentJob.outputs.learnedMatchingPairsDir = getArtifactUrl(jobId, path.join('priors', 'learned_matching', 'pairs'));
      currentJob.outputs.learnedMatchingPreviewDir = getArtifactUrl(jobId, path.join('priors', 'learned_matching', 'previews'));
      currentJob.metadata = {
        ...currentJob.metadata,
        learnedMatchingSummary: learnedMatchingResult.summary,
      };
      currentJob = updateStage(currentJob, 'learned_matching', 'completed');
      currentJob = updateStage(currentJob, 'global_sfm', 'running');
      return currentJob;
    });

    activeStageId = 'global_sfm';
    job = await loadJob(jobId);
    const globalSfmResult = await runGlobalSfm(job);

    job = await mutateJob(jobId, async (currentJob) => {
      currentJob.updatedAt = nowIso();
      currentJob.status = 'running_dense_evidence';
      currentJob.outputs.globalSfmSummaryPath = getArtifactUrl(jobId, path.join('sfm', 'global_sfm', 'summary.json'));
      currentJob.outputs.globalSfmDatabasePath = getArtifactUrl(jobId, path.join('sfm', 'global_sfm', 'database.db'));
      currentJob.outputs.globalSfmSparseModelDir = getArtifactUrl(jobId, path.join('sfm', 'global_sfm', 'sparse'));
      currentJob.outputs.globalSfmTextModelDir = getArtifactUrl(jobId, path.join('sfm', 'global_sfm', 'text-model'));
      currentJob.outputs.globalSfmCamerasPath = getArtifactUrl(jobId, path.join('sfm', 'global_sfm', 'text-model', 'cameras.txt'));
      currentJob.outputs.globalSfmImagesPath = getArtifactUrl(jobId, path.join('sfm', 'global_sfm', 'text-model', 'images.txt'));
      currentJob.outputs.globalSfmPointsPath = getArtifactUrl(jobId, path.join('sfm', 'global_sfm', 'text-model', 'points3D.txt'));
      currentJob.outputs.fast3rPointmapTailRescueSummaryPath = getArtifactUrl(jobId, path.join('sfm', 'global_sfm', 'fast3r_pointmap_tail_rescue', 'summary.json'));
      currentJob.outputs.fast3rPointmapTailRescueTextModelDir = getArtifactUrl(jobId, path.join('sfm', 'global_sfm', 'fast3r_pointmap_tail_rescue', 'text-model'));
      currentJob.outputs.fast3rPointmapTailRescueImagesPath = getArtifactUrl(jobId, path.join('sfm', 'global_sfm', 'fast3r_pointmap_tail_rescue', 'text-model', 'images.txt'));
      currentJob.outputs.fast3rPointmapTailRescuePointsPath = getArtifactUrl(jobId, path.join('sfm', 'global_sfm', 'fast3r_pointmap_tail_rescue', 'text-model', 'points3D.txt'));
      currentJob.outputs.fast3rPointmapTailRescuePosesPath = getArtifactUrl(jobId, path.join('sfm', 'global_sfm', 'fast3r_pointmap_tail_rescue', 'poses.json'));
      currentJob.outputs.experimentalMultiviewSummaryPath = getArtifactUrl(jobId, path.join('sfm', 'global_sfm', 'experimental_multiview', 'summary.json'));
      currentJob.outputs.experimentalMultiviewBundlePath = getArtifactUrl(jobId, path.join('sfm', 'global_sfm', 'experimental_multiview', 'bundle.npz'));
      currentJob.outputs.experimentalMultiviewCameraGraphPath = getArtifactUrl(jobId, path.join('sfm', 'global_sfm', 'experimental_multiview', 'camera_graph.json'));
      currentJob.outputs.experimentalMultiviewPoseGraphPath = getArtifactUrl(jobId, path.join('sfm', 'global_sfm', 'experimental_multiview', 'pose_graph.json'));
      currentJob.metadata = {
        ...currentJob.metadata,
        globalSfmSummary: globalSfmResult.summary,
      };
      currentJob = updateStage(currentJob, 'global_sfm', 'completed');
      currentJob = updateStage(currentJob, 'dense_evidence', 'running');
      return currentJob;
    });

    activeStageId = 'dense_evidence';
    job = await loadJob(jobId);
    const denseEvidenceResult = await runDenseEvidence(job);

    job = await mutateJob(jobId, async (currentJob) => {
      currentJob.updatedAt = nowIso();
      currentJob.status = 'running_plane_layout';
      currentJob.outputs.denseEvidenceSummaryPath = getArtifactUrl(jobId, path.join('dense_evidence', 'summary.json'));
      currentJob.outputs.denseEvidencePointCloudPath = getArtifactUrl(jobId, path.join('dense_evidence', 'fused_scene.ply'));
      currentJob.outputs.denseEvidencePointsPath = getArtifactUrl(jobId, path.join('dense_evidence', 'points.npy'));
      currentJob.outputs.denseEvidenceColorsPath = getArtifactUrl(jobId, path.join('dense_evidence', 'colors.npy'));
      currentJob.metadata = {
        ...currentJob.metadata,
        denseEvidenceSummary: denseEvidenceResult.summary,
      };
      currentJob = updateStage(currentJob, 'dense_evidence', 'completed');
      currentJob = updateStage(currentJob, 'plane_layout', 'running');
      return currentJob;
    });

    activeStageId = 'plane_layout';
    job = await loadJob(jobId);
    const planeLayoutResult = await runPlaneLayout(job);

    job = await mutateJob(jobId, async (currentJob) => {
      currentJob.updatedAt = nowIso();
      currentJob.status = 'running_opening_detection';
      currentJob.outputs.planeLayoutSummaryPath = getArtifactUrl(jobId, path.join('layout', 'plane_layout', 'summary.json'));
      currentJob.outputs.planeLayoutPath = getArtifactUrl(jobId, path.join('layout', 'plane_layout', 'layout.json'));
      currentJob.metadata = {
        ...currentJob.metadata,
        planeLayoutSummary: planeLayoutResult.summary,
      };
      currentJob = updateStage(currentJob, 'plane_layout', 'completed');
      currentJob = updateStage(currentJob, 'opening_detection', 'running');
      return currentJob;
    });

    activeStageId = 'opening_detection';
    job = await loadJob(jobId);
    const openingDetectionResult = await runOpeningDetection(job);

    job = await mutateJob(jobId, async (currentJob) => {
      currentJob.updatedAt = nowIso();
      currentJob.status = 'running_mesh_authoring';
      currentJob.outputs.openingDetectionSummaryPath = getArtifactUrl(jobId, path.join('layout', 'opening_detection', 'summary.json'));
      currentJob.outputs.openingCandidatesPath = getArtifactUrl(jobId, path.join('layout', 'opening_detection', 'candidates.json'));
      currentJob.outputs.openingDebugDir = getArtifactUrl(jobId, path.join('layout', 'opening_detection', 'debug'));
      currentJob.metadata = {
        ...currentJob.metadata,
        openingDetectionSummary: openingDetectionResult.summary,
      };
      currentJob = updateStage(currentJob, 'opening_detection', 'completed');
      currentJob = updateStage(currentJob, 'mesh_authoring', 'running');
      return currentJob;
    });

    activeStageId = 'mesh_authoring';
    job = await loadJob(jobId);
    const meshAuthoringResult = await runMeshAuthoring(job);

    job = await mutateJob(jobId, async (currentJob) => {
      currentJob.updatedAt = nowIso();
      currentJob.status = 'running_uv_initial_bake';
      currentJob.outputs.meshAuthoringSummaryPath = getArtifactUrl(jobId, path.join('mesh', 'authoring', 'summary.json'));
      currentJob.outputs.shellMeshPath = getArtifactUrl(jobId, path.join('mesh', 'authoring', 'shell_mesh.obj'));
      currentJob.outputs.shellMeshPlyPath = getArtifactUrl(jobId, path.join('mesh', 'authoring', 'shell_mesh.ply'));
      currentJob.outputs.meshPanelBreakdownPath = getArtifactUrl(jobId, path.join('mesh', 'authoring', 'panel_breakdown.json'));
      currentJob.outputs.detailMeshSummaryPath = meshAuthoringResult.detailMeshSummaryPath
        ? getArtifactUrl(jobId, path.join('mesh', 'authoring', 'detail_mesh', 'summary.json'))
        : null;
      currentJob.metadata = {
        ...currentJob.metadata,
        meshAuthoringSummary: meshAuthoringResult.summary,
      };
      currentJob = updateStage(currentJob, 'mesh_authoring', 'completed');
      currentJob = updateStage(currentJob, 'uv_initial_bake', 'running');
      return currentJob;
    });

    activeStageId = 'uv_initial_bake';
    job = await loadJob(jobId);
    const uvInitialBakeResult = await runUvInitialBake(job);

    job = await mutateJob(jobId, async (currentJob) => {
      currentJob.updatedAt = nowIso();
      currentJob.status = 'running_appearance_refinement';
      currentJob.outputs.uvInitialBakeSummaryPath = getArtifactUrl(jobId, path.join('texture', 'uv_initial_bake', 'summary.json'));
      currentJob.outputs.uvTexturedMeshPath = getArtifactUrlForAbsolutePath(jobId, uvInitialBakeResult.summary.texturedMeshPath);
      currentJob.outputs.uvTexturePath = getArtifactUrlForAbsolutePath(jobId, uvInitialBakeResult.summary.texturePath);
      currentJob.metadata = {
        ...currentJob.metadata,
        uvInitialBakeSummary: uvInitialBakeResult.summary,
      };
      currentJob = updateStage(currentJob, 'uv_initial_bake', 'completed');
      currentJob = updateStage(currentJob, 'appearance_refinement', 'running');
      return currentJob;
    });

    activeStageId = 'appearance_refinement';
    job = await loadJob(jobId);
    const appearanceRefinementResult = await runAppearanceRefinement(job);

    job = await mutateJob(jobId, async (currentJob) => {
      currentJob.updatedAt = nowIso();
      currentJob.status = 'running_export_qa';
      currentJob.outputs.appearanceSummaryPath = getArtifactUrl(jobId, path.join('appearance', 'refinement', 'summary.json'));
      currentJob.outputs.refinedMeshPath = getArtifactUrlForAbsolutePath(jobId, appearanceRefinementResult.summary.refinedMeshPath);
      currentJob.outputs.refinedTexturePath = getArtifactUrlForAbsolutePath(jobId, appearanceRefinementResult.summary.refinedTexturePath);
      currentJob.metadata = {
        ...currentJob.metadata,
        appearanceRefinementSummary: appearanceRefinementResult.summary,
      };
      currentJob = updateStage(currentJob, 'appearance_refinement', 'completed');
      currentJob = updateStage(currentJob, 'export_qa', 'running');
      return currentJob;
    });

    activeStageId = 'export_qa';
    job = await loadJob(jobId);
    const exportQaResult = await runExportQa(job);

    job = await mutateJob(jobId, async (currentJob) => {
      currentJob.updatedAt = nowIso();
      currentJob.status = 'completed';
      currentJob.outputs.exportSummaryPath = getArtifactUrl(jobId, path.join('export', 'qa', 'summary.json'));
      currentJob.outputs.finalGlbPath = getArtifactUrlForAbsolutePath(jobId, exportQaResult.summary.finalGlbPath);
      currentJob.outputs.optimizedGlbPath = getArtifactUrlForAbsolutePath(jobId, exportQaResult.summary.optimizedGlbPath);
      currentJob.outputs.qaReportPath = getArtifactUrlForAbsolutePath(jobId, exportQaResult.summary.qaReportPath);
      currentJob.metadata = {
        ...currentJob.metadata,
        exportQaSummary: exportQaResult.summary,
        completedAt: nowIso(),
      };
      currentJob = updateStage(currentJob, 'export_qa', 'completed');
      return currentJob;
    });

    job = await loadJob(jobId);
    await writeExecutionContract(job, job.requestedProcessing?.inputOptions || {});
    await finalizeRoomScanMirror(jobId);
  } catch (error) {
    await setJobFailure(jobId, error, activeStageId);
    throw error;
  }
}

function startQueuedMasterJob(jobId) {
  if (activeRuns.has(jobId)) {
    return activeRuns.get(jobId);
  }

  const promise = runMasterJob(jobId)
    .catch((error) => {
      console.error(`[MasterPipeline] Job ${jobId} failed:`, error);
      return null;
    })
    .finally(() => {
      activeRuns.delete(jobId);
    });

  activeRuns.set(jobId, promise);
  return promise;
}

async function queueMasterProcessing(jobId, options = {}) {
  const job = await loadJob(jobId);

  if (!hasInput(job)) {
    throw new Error('input_not_uploaded');
  }

  const queuedJob = await mutateJob(jobId, async (currentJob) => {
    currentJob.updatedAt = nowIso();
    currentJob.status = 'queued';
    currentJob.requestedProcessing = {
      queuedAt: nowIso(),
      inputOptions: options,
      executionPlan: buildExecutionPlan(options),
      note: 'master_v1 is a fully separate canonical system. Stage 1 through Stage 13 execute behind this service boundary and fail fast when required downstream dependencies are unavailable.',
    };
    currentJob.outputs.executionPlanPath = getArtifactUrl(jobId, path.join('outputs', 'master-execution-plan.json'));
    currentJob = updateStage(currentJob, 'ingest', 'completed');
    currentJob = updateStage(currentJob, 'frame_qc', 'queued');
    currentJob = updateStage(currentJob, 'camera_calibration', 'queued');
    return currentJob;
  });

  await writeExecutionContract(queuedJob, options);
  void startQueuedMasterJob(jobId);
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

ensureMasterDataDirSync();

export {
  MASTER_PIPELINE_DATA_DIR,
  MASTER_PIPELINE_SPEC,
  MASTER_PIPELINE_VERSION,
  attachImagesToJob,
  attachMetadataToJob,
  attachVideoToJob,
  createMasterJob,
  getJobDir,
  listJobs,
  loadJob,
  queueMasterProcessing,
  resolveArtifactPath,
  finalizeRemoteWorkerSuccess,
  finalizeRoomScanMirror,
};