#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';

import {
  attachImagesToJob,
  attachMetadataToJob,
  createMasterJob,
  loadJob,
  queueMasterProcessing,
} from '../server/services/masterPipeline.js';

const SUPPORTED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif']);
const DEFAULT_GAUSSIAN_VIEWER_PRESET = 'legacy_metric3d_masked_viewer_balanced_density';
const REF_GAUSSIAN_BASELINE_VIEWER_PRESET = 'legacy_metric3d_sharp_mirror';
const REF_GAUSSIAN_BASELINE_DEPTH_PRIORS_MAX_POINTS_PER_IMAGE = 24000;
const DEFAULT_IMAGE_SIZE = 1024;
const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_TIMEOUT_MS = 45 * 60 * 1000;
const DEFAULT_CAPTURE_MODE = 'room_tour';
const DEFAULT_USER_ID = 'local-smoke-test';
const DEFAULT_REF_GAUSSIAN_PROFILE_MODE = '';
const TERMINAL_STATUSES = new Set(['completed', 'failed']);

const COMPARISON_SPECS = [
  {
    learnedMatchingPreset: 'loftr_indoor',
    labelSuffix: 'Real EfficientLoFTR Only',
    captureSourceSuffix: 'real_efficientloftr_only',
    efficientLoftrRequired: true,
  },
  {
    learnedMatchingPreset: 'disk_lightglue_loftr',
    labelSuffix: 'DISK Hybrid Real EfficientLoFTR Rescue',
    captureSourceSuffix: 'disk_hybrid_real_efficientloftr_rescue',
    efficientLoftrRequired: true,
  },
  {
    learnedMatchingPreset: 'roma_v2',
    labelSuffix: 'RoMa V2 Pairwise',
    captureSourceSuffix: 'roma_v2_pairwise',
    efficientLoftrRequired: false,
  },
];

function printUsage() {
  console.log(`Usage:
  node scripts/run-master-v1-gaussian-compare.mjs --images-dir <dir> --metadata-path <file> [options]

Options:
  --images-dir <dir>               Directory containing source images
  --metadata-path <file>           JSON metadata template to clone per job
  --job-prefix <text>              Prefix for job and room labels
  --capture-source-prefix <text>   Prefix for captureSource labels
  --user-id <id>                   User id attached to each job (default: ${DEFAULT_USER_ID})
  --capture-mode <mode>            Capture mode (default: ${DEFAULT_CAPTURE_MODE})
  --viewer-preset <preset>         Gaussian viewer preset (default: ${DEFAULT_GAUSSIAN_VIEWER_PRESET})
  --image-size <n>                 Learned matching image size (default: ${DEFAULT_IMAGE_SIZE})
  --include-presets <csv>          Restrict run to a comma-separated preset subset
  --gsplat-iterations <n>          Override Gaussian splat training iterations
  --gaussian-max-init-points <n>   Override Gaussian init point cap
  --gaussian-depth-priors-max-points-per-image <n>
                                   Override Metric3D seed budget per image
  --mirror-gaussian-command <cmd>  External MirrorGaussian command template; if set this compare run requires that stage
  --disable-mirror-gaussian        Explicitly disable the default MirrorGaussian worker fork
  --ref-gaussian-command <cmd>     External RefGaussian command template; if set this compare run requires that fork
  --ref-gaussian-only              Skip vanilla gsplat training and run only the RefGaussian fork
  --prefer-ref-gaussian            Publish RefGaussian as the primary viewer for the saved scan
  --ref-gaussian-profile-mode <m>  Force a RefGaussian adapter profile mode
                                   (adaptive | canonical_bathroom_light | sfm_only_marginal_indoor)
  --scaffold-gs-command <cmd>      External Scaffold-GS command template; if set this compare run requires that fork
  --scaffold-gs-only               Skip vanilla/RefGaussian training and run only the Scaffold-GS fork
  --prefer-scaffold-gs             Publish Scaffold-GS as the primary viewer for the saved scan
  --poll-interval-ms <n>           Poll interval in milliseconds (default: ${DEFAULT_POLL_INTERVAL_MS})
  --timeout-ms <n>                 Total wait timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})
  --help                           Show this help
`);
}

function parseArgs(argv) {
  const args = {
    imagesDir: '',
    metadataPath: '',
    jobPrefix: 'Gaussian Compare',
    captureSourcePrefix: 'gaussian_compare',
    userId: DEFAULT_USER_ID,
    captureMode: DEFAULT_CAPTURE_MODE,
    viewerPreset: DEFAULT_GAUSSIAN_VIEWER_PRESET,
    imageSize: DEFAULT_IMAGE_SIZE,
    includePresets: [],
    gsplatIterations: null,
    gaussianMaxInitPoints: null,
    gaussianDepthPriorsMaxPointsPerImage: null,
    mirrorGaussianCommand: '',
    disableMirrorGaussian: false,
    refGaussianCommand: '',
    refGaussianOnly: false,
    preferRefGaussian: false,
    refGaussianProfileMode: DEFAULT_REF_GAUSSIAN_PROFILE_MODE,
    scaffoldGsCommand: '',
    scaffoldGsOnly: false,
    preferScaffoldGs: false,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    viewerPresetExplicit: false,
    gaussianDepthPriorsMaxPointsPerImageExplicit: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--help') {
      printUsage();
      process.exit(0);
    }
    if (arg === '--prefer-ref-gaussian') {
      args.preferRefGaussian = true;
      continue;
    }
    if (arg === '--ref-gaussian-only') {
      args.refGaussianOnly = true;
      continue;
    }
    if (arg === '--scaffold-gs-only') {
      args.scaffoldGsOnly = true;
      continue;
    }
    if (arg === '--prefer-scaffold-gs') {
      args.preferScaffoldGs = true;
      continue;
    }
    if (arg === '--disable-mirror-gaussian') {
      args.disableMirrorGaussian = true;
      continue;
    }

    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    const key = arg.slice(2);
    const nextValue = argv[index + 1];
    if (!nextValue || nextValue.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }
    index += 1;

    switch (key) {
      case 'images-dir':
        args.imagesDir = nextValue;
        break;
      case 'metadata-path':
        args.metadataPath = nextValue;
        break;
      case 'job-prefix':
        args.jobPrefix = nextValue;
        break;
      case 'capture-source-prefix':
        args.captureSourcePrefix = nextValue;
        break;
      case 'user-id':
        args.userId = nextValue;
        break;
      case 'capture-mode':
        args.captureMode = nextValue;
        break;
      case 'viewer-preset':
        args.viewerPreset = nextValue;
        args.viewerPresetExplicit = true;
        break;
      case 'image-size':
        args.imageSize = Number.parseInt(nextValue, 10);
        break;
      case 'include-presets':
        args.includePresets = nextValue.split(',').map((value) => value.trim()).filter(Boolean);
        break;
      case 'gsplat-iterations':
        args.gsplatIterations = Number.parseInt(nextValue, 10);
        break;
      case 'gaussian-max-init-points':
        args.gaussianMaxInitPoints = Number.parseInt(nextValue, 10);
        break;
      case 'gaussian-depth-priors-max-points-per-image':
        args.gaussianDepthPriorsMaxPointsPerImage = Number.parseInt(nextValue, 10);
        args.gaussianDepthPriorsMaxPointsPerImageExplicit = true;
        break;
      case 'mirror-gaussian-command':
        args.mirrorGaussianCommand = nextValue;
        break;
      case 'ref-gaussian-command':
        args.refGaussianCommand = nextValue;
        break;
      case 'ref-gaussian-profile-mode':
        args.refGaussianProfileMode = nextValue;
        break;
      case 'scaffold-gs-command':
        args.scaffoldGsCommand = nextValue;
        break;
      case 'poll-interval-ms':
        args.pollIntervalMs = Number.parseInt(nextValue, 10);
        break;
      case 'timeout-ms':
        args.timeoutMs = Number.parseInt(nextValue, 10);
        break;
      default:
        throw new Error(`Unknown option: --${key}`);
    }
  }

  if (!args.imagesDir) {
    throw new Error('--images-dir is required');
  }
  if (!args.metadataPath) {
    throw new Error('--metadata-path is required');
  }
  if (!Number.isFinite(args.imageSize) || args.imageSize <= 0) {
    throw new Error('--image-size must be a positive integer');
  }
  if (args.gsplatIterations !== null && (!Number.isFinite(args.gsplatIterations) || args.gsplatIterations <= 0)) {
    throw new Error('--gsplat-iterations must be a positive integer');
  }
  if (args.gaussianMaxInitPoints !== null && (!Number.isFinite(args.gaussianMaxInitPoints) || args.gaussianMaxInitPoints <= 0)) {
    throw new Error('--gaussian-max-init-points must be a positive integer');
  }
  if (
    args.gaussianDepthPriorsMaxPointsPerImage !== null
    && (!Number.isFinite(args.gaussianDepthPriorsMaxPointsPerImage) || args.gaussianDepthPriorsMaxPointsPerImage <= 0)
  ) {
    throw new Error('--gaussian-depth-priors-max-points-per-image must be a positive integer');
  }
  if (!Number.isFinite(args.pollIntervalMs) || args.pollIntervalMs <= 0) {
    throw new Error('--poll-interval-ms must be a positive integer');
  }
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive integer');
  }
  if (args.refGaussianOnly && args.scaffoldGsOnly) {
    throw new Error('--ref-gaussian-only and --scaffold-gs-only are mutually exclusive');
  }

  if (args.refGaussianCommand) {
    // Preserve the stronger Bathroom 2 vanilla baseline for RefGaussian comparison
    // runs unless the caller explicitly requests a different vanilla setup.
    if (!args.viewerPresetExplicit) {
      args.viewerPreset = REF_GAUSSIAN_BASELINE_VIEWER_PRESET;
    }
    if (!args.gaussianDepthPriorsMaxPointsPerImageExplicit) {
      args.gaussianDepthPriorsMaxPointsPerImage = REF_GAUSSIAN_BASELINE_DEPTH_PRIORS_MAX_POINTS_PER_IMAGE;
    }
  }

  return args;
}

async function listImagePaths(imagesDir) {
  const entries = await fs.readdir(imagesDir, { withFileTypes: true });
  const imagePaths = entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(imagesDir, entry.name))
    .filter((filePath) => SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase()))
    .sort((left, right) => left.localeCompare(right));

  if (imagePaths.length === 0) {
    throw new Error(`No supported images found in ${imagesDir}`);
  }

  return imagePaths;
}

function buildStampedLabel(prefix, suffix, stamp) {
  return `${prefix} - ${suffix} - ${stamp}`;
}

function buildCaptureSource(prefix, suffix) {
  return `${prefix}_${suffix}`
    .trim()
    .replace(/[^a-zA-Z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

async function queueComparisonJob(spec, args, imagePaths, metadataTemplate, stamp) {
  const label = buildStampedLabel(args.jobPrefix, spec.labelSuffix, stamp);
  const captureSource = buildCaptureSource(args.captureSourcePrefix, spec.captureSourceSuffix);

  const job = await createMasterJob({
    jobName: label,
    userId: args.userId,
    captureMode: args.captureMode,
  });

  await attachImagesToJob(
    job.id,
    imagePaths.map((imagePath) => ({ path: imagePath })),
  );

  await attachMetadataToJob(job.id, {
    ...metadataTemplate,
    captureMode: args.captureMode,
    roomName: label,
    captureSource,
    userId: args.userId,
    capturedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  });

  await queueMasterProcessing(job.id, {
    requireGaussianSplatting: true,
    gaussianOnly: true,
    gaussianViewerPreset: args.viewerPreset,
    learnedMatchingPreset: spec.learnedMatchingPreset,
    learnedMatchingImageSize: args.imageSize,
    efficientLoftrRequired: spec.efficientLoftrRequired,
    ...(args.gsplatIterations !== null ? { gsplatIterations: args.gsplatIterations } : {}),
    ...(args.gaussianMaxInitPoints !== null ? { gaussianMaxInitPoints: args.gaussianMaxInitPoints } : {}),
    ...(args.gaussianDepthPriorsMaxPointsPerImage !== null
      ? { gaussianDepthPriorsMaxPointsPerImage: args.gaussianDepthPriorsMaxPointsPerImage }
      : {}),
    ...(args.mirrorGaussianCommand
      ? {
        mirrorGaussianCommand: args.mirrorGaussianCommand,
        requireMirrorGaussian: true,
      }
      : args.disableMirrorGaussian
        ? {
          mirrorGaussianCommand: null,
          requireMirrorGaussian: false,
        }
        : {}),
    ...(args.refGaussianOnly || args.preferRefGaussian || args.refGaussianCommand
      ? {
        ...(args.refGaussianCommand ? { refGaussianCommand: args.refGaussianCommand } : {}),
        requireRefGaussian: true,
        ...(args.refGaussianProfileMode ? { refGaussianProfileMode: args.refGaussianProfileMode } : {}),
        ...(args.refGaussianOnly ? { refGaussianOnly: true } : {}),
        ...(args.preferRefGaussian ? { preferredGaussianBackend: 'ref_gaussian' } : {}),
      }
      : {}),
    ...(args.scaffoldGsOnly || args.preferScaffoldGs || args.scaffoldGsCommand
      ? {
        ...(args.scaffoldGsCommand ? { scaffoldGsCommand: args.scaffoldGsCommand } : {}),
        requireScaffoldGs: true,
        ...(args.scaffoldGsOnly ? { scaffoldGsOnly: true } : {}),
        ...(args.preferScaffoldGs ? { preferredGaussianBackend: 'scaffold_gs' } : {}),
      }
      : {}),
  });

  return {
    jobId: job.id,
    label,
    captureSource,
    learnedMatchingPreset: spec.learnedMatchingPreset,
  };
}

async function waitForJobs(jobIds, pollIntervalMs, timeoutMs) {
  const startedAt = Date.now();
  const seenStatus = new Map();
  const completed = new Map();

  while (completed.size < jobIds.length) {
    if ((Date.now() - startedAt) > timeoutMs) {
      const pending = jobIds.filter((jobId) => !completed.has(jobId));
      throw new Error(`Timed out waiting for jobs: ${pending.join(', ')}`);
    }

    for (const jobId of jobIds) {
      if (completed.has(jobId)) {
        continue;
      }

      const job = await loadJob(jobId);
      const statusMarker = `${job.status}:${job.metadata?.failedStage || ''}`;
      if (seenStatus.get(jobId) !== statusMarker) {
        seenStatus.set(jobId, statusMarker);
        console.log(`STATUS ${jobId} ${job.status}${job.metadata?.failedStage ? ` failedStage=${job.metadata.failedStage}` : ''}`);
      }

      if (TERMINAL_STATUSES.has(job.status)) {
        completed.set(jobId, job);
        console.log(`FINAL ${jobId} ${job.status}`);
      }
    }

    if (completed.size < jobIds.length) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  return completed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const imagePaths = await listImagePaths(path.resolve(args.imagesDir));
  const metadataTemplate = JSON.parse(await fs.readFile(path.resolve(args.metadataPath), 'utf8'));
  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const selectedSpecs = args.includePresets.length === 0
    ? COMPARISON_SPECS
    : COMPARISON_SPECS.filter((spec) => args.includePresets.includes(spec.learnedMatchingPreset));

  if (selectedSpecs.length === 0) {
    throw new Error(`No comparison presets matched: ${args.includePresets.join(', ')}`);
  }

  const queuedJobs = [];
  for (const spec of selectedSpecs) {
    const queued = await queueComparisonJob(spec, args, imagePaths, metadataTemplate, stamp);
    queuedJobs.push(queued);
    console.log(`QUEUED ${queued.learnedMatchingPreset} ${queued.jobId} ${queued.label}`);
  }

  const completedJobs = await waitForJobs(
    queuedJobs.map((job) => job.jobId),
    args.pollIntervalMs,
    args.timeoutMs,
  );

  const summary = queuedJobs.map((queued) => {
    const job = completedJobs.get(queued.jobId);
    return {
      jobId: queued.jobId,
      learnedMatchingPreset: queued.learnedMatchingPreset,
      label: queued.label,
      captureSource: queued.captureSource,
      status: job.status,
      failedStage: job.metadata?.failedStage || null,
      lastError: job.metadata?.lastError ? String(job.metadata.lastError).slice(0, 240) : null,
    };
  });

  console.log(JSON.stringify(summary, null, 2));

  if (summary.some((entry) => entry.status !== 'completed')) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});