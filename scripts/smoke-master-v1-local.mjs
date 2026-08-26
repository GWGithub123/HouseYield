#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';

const DEFAULT_BASE_URL = 'http://127.0.0.1:3001';
const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const DEFAULT_MAX_POLL_FAILURES = 12;
const SUPPORTED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif']);

function printUsage() {
  console.log(`Usage:
  npm run smoke:master-v1:local -- --images-dir <dir> [options]

Options:
  --images-dir <dir>       Directory of source images to upload
  --base-url <url>         Backend base URL (default: ${DEFAULT_BASE_URL})
  --job-name <name>        Job name (default: master-v1-local-smoke)
  --room-name <name>       Room name in metadata (default: Local Master v1 Smoke Test)
  --user-id <id>           User id to attach to the job (default: local-smoke-test)
  --property-id <id>       Optional property id
  --limit <n>              Limit how many images to upload
  --gaussian-only          Request gaussian-focused execution
  --mobile-token <token>   Optional x-mobile-token for protected APIs
  --poll-interval-ms <n>   Poll interval in ms (default: ${DEFAULT_POLL_INTERVAL_MS})
  --timeout-ms <n>         Overall timeout in ms (default: ${DEFAULT_TIMEOUT_MS})
  --help                   Show this help
`);
}

function parseArgs(argv) {
  const args = {
    baseUrl: DEFAULT_BASE_URL,
    jobName: 'master-v1-local-smoke',
    roomName: 'Local Master v1 Smoke Test',
    userId: 'local-smoke-test',
    propertyId: null,
    limit: 0,
    gaussianOnly: false,
    mobileToken: process.env.MOBILE_SCAN_TOKEN || '',
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    imagesDir: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--help') {
      printUsage();
      process.exit(0);
    }

    if (arg === '--gaussian-only') {
      args.gaussianOnly = true;
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
      case 'base-url':
        args.baseUrl = nextValue.replace(/\/+$/, '');
        break;
      case 'job-name':
        args.jobName = nextValue;
        break;
      case 'room-name':
        args.roomName = nextValue;
        break;
      case 'user-id':
        args.userId = nextValue;
        break;
      case 'property-id':
        args.propertyId = nextValue;
        break;
      case 'limit':
        args.limit = Number.parseInt(nextValue, 10);
        break;
      case 'poll-interval-ms':
        args.pollIntervalMs = Number.parseInt(nextValue, 10);
        break;
      case 'timeout-ms':
        args.timeoutMs = Number.parseInt(nextValue, 10);
        break;
      case 'mobile-token':
        args.mobileToken = nextValue;
        break;
      default:
        throw new Error(`Unknown option: --${key}`);
    }
  }

  if (!args.imagesDir) {
    throw new Error('--images-dir is required');
  }

  if (!Number.isFinite(args.pollIntervalMs) || args.pollIntervalMs <= 0) {
    throw new Error('--poll-interval-ms must be a positive integer');
  }

  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive integer');
  }

  if (!Number.isFinite(args.limit) || args.limit < 0) {
    throw new Error('--limit must be 0 or a positive integer');
  }

  return args;
}

function withAuthHeaders(args, headers = {}) {
  if (args.mobileToken) {
    return {
      ...headers,
      'x-mobile-token': args.mobileToken,
    };
  }

  return headers;
}

async function listImages(imagesDir, limit) {
  const entries = await fs.readdir(imagesDir, { withFileTypes: true });
  const imagePaths = entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(imagesDir, entry.name))
    .filter((filePath) => SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase()))
    .sort((left, right) => left.localeCompare(right));

  if (imagePaths.length === 0) {
    throw new Error(`No supported images found in ${imagesDir}`);
  }

  return limit > 0 ? imagePaths.slice(0, limit) : imagePaths;
}

async function deriveIntrinsics(imagePath) {
  const metadata = await sharp(imagePath).metadata();
  const width = metadata.width || 1920;
  const height = metadata.height || 1080;
  const focalLength = Math.max(width, height) * 1.2;

  return {
    fx: focalLength,
    fy: focalLength,
    cx: width / 2,
    cy: height / 2,
    width,
    height,
  };
}

async function parseJsonResponse(response, fallbackMessage) {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload
      ? String(payload.error || fallbackMessage)
      : fallbackMessage;
    throw new Error(message);
  }

  return payload;
}

async function createJob(baseUrl, args) {
  const response = await fetch(`${baseUrl}/api/master-reconstruction/jobs`, {
    method: 'POST',
    headers: withAuthHeaders(args, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      jobName: args.jobName,
      userId: args.userId,
      propertyId: args.propertyId,
      captureMode: 'local_vm_smoke_test',
    }),
  });

  const payload = await parseJsonResponse(response, 'Failed to create master_v1 smoke test job');
  return payload.job;
}

async function uploadImages(baseUrl, jobId, imagePaths, args) {
  const formData = new FormData();
  for (const imagePath of imagePaths) {
    const bytes = await fs.readFile(imagePath);
    const blob = new Blob([bytes]);
    formData.append('images', blob, path.basename(imagePath));
  }

  const response = await fetch(`${baseUrl}/api/master-reconstruction/jobs/${jobId}/images`, {
    method: 'POST',
    headers: withAuthHeaders(args),
    body: formData,
  });

  const payload = await parseJsonResponse(response, 'Failed to upload master_v1 smoke test images');
  return payload.job;
}

async function uploadMetadata(baseUrl, jobId, args, imagePaths) {
  const intrinsics = await deriveIntrinsics(imagePaths[0]);
  const now = new Date().toISOString();

  const response = await fetch(`${baseUrl}/api/master-reconstruction/jobs/${jobId}/metadata`, {
    method: 'POST',
    headers: withAuthHeaders(args, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      roomName: args.roomName,
      propertyId: args.propertyId,
      userId: args.userId,
      pipelineVersion: 'master_v1',
      captureSource: 'local_vm_smoke_test',
      capturedAt: now,
      completedAt: now,
      cameraIntrinsics: {
        fx: intrinsics.fx,
        fy: intrinsics.fy,
        cx: intrinsics.cx,
        cy: intrinsics.cy,
      },
      captureStats: {
        photoCount: imagePaths.length,
        clusterCount: 1,
        pathLengthMeters: 1,
        captureTimeSeconds: Math.max(1, imagePaths.length),
      },
      localSmokeTest: {
        imagesDir: path.resolve(args.imagesDir),
        imageCount: imagePaths.length,
      },
    }),
  });

  const payload = await parseJsonResponse(response, 'Failed to upload master_v1 smoke test metadata');
  return payload.job;
}

async function queueProcessing(baseUrl, jobId, args) {
  const response = await fetch(`${baseUrl}/api/master-reconstruction/jobs/${jobId}/process`, {
    method: 'POST',
    headers: withAuthHeaders(args, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      requireGaussianSplatting: args.gaussianOnly,
    }),
  });

  const payload = await parseJsonResponse(response, 'Failed to queue master_v1 smoke test job');
  return payload.job;
}

async function getJob(baseUrl, jobId, args) {
  const response = await fetch(`${baseUrl}/api/master-reconstruction/jobs/${jobId}`, {
    headers: withAuthHeaders(args),
  });
  const payload = await parseJsonResponse(response, 'Failed to fetch master_v1 job');
  return payload.job;
}

function summarizeStages(job) {
  return (job.stages || [])
    .map((stage) => `${stage.id}:${stage.status}`)
    .join(', ');
}

function sleep(durationMs) {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function formatPollError(error) {
  if (error?.cause?.code) {
    return `${error.message} (${error.cause.code})`;
  }

  return error?.message || 'unknown polling error';
}

async function pollUntilFinished(baseUrl, jobId, args) {
  const startedAt = Date.now();
  let lastStatus = null;
  let lastStageSummary = null;
  let consecutivePollFailures = 0;

  while (Date.now() - startedAt < args.timeoutMs) {
    let job = null;

    try {
      job = await getJob(baseUrl, jobId, args);
      if (consecutivePollFailures > 1) {
        console.warn(`[master-v1] poll recovered after ${consecutivePollFailures} consecutive fetch failures`);
      }
      consecutivePollFailures = 0;
    } catch (error) {
      consecutivePollFailures += 1;
      const formattedError = formatPollError(error);

      if (consecutivePollFailures === 2) {
        console.warn(
          `[master-v1] poll retrying after consecutive fetch failures: ${formattedError}`,
        );
      } else if (consecutivePollFailures > 2) {
        console.warn(
          `[master-v1] poll still failing ${consecutivePollFailures}/${DEFAULT_MAX_POLL_FAILURES}: ${formattedError}`,
        );
      }

      if (consecutivePollFailures >= DEFAULT_MAX_POLL_FAILURES) {
        throw new Error(`Polling failed ${consecutivePollFailures} times in a row: ${formattedError}`);
      }

      await sleep(args.pollIntervalMs);
      continue;
    }

    const stageSummary = summarizeStages(job);

    if (job.status !== lastStatus || stageSummary !== lastStageSummary) {
      console.log(`[master-v1] status=${job.status}`);
      console.log(`[master-v1] stages=${stageSummary}`);
      if (job.metadata?.lastError) {
        console.log(`[master-v1] lastError=${job.metadata.lastError}`);
      }
      lastStatus = job.status;
      lastStageSummary = stageSummary;
    }

    if (job.status === 'completed' || job.status === 'failed') {
      return job;
    }

    await sleep(args.pollIntervalMs);
  }

  throw new Error(`Timed out waiting for job ${jobId}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const imagePaths = await listImages(args.imagesDir, args.limit);

  console.log(`[master-v1] using backend ${args.baseUrl}`);
  console.log(`[master-v1] uploading ${imagePaths.length} image(s) from ${path.resolve(args.imagesDir)}`);

  const createdJob = await createJob(args.baseUrl, args);
  console.log(`[master-v1] created job ${createdJob.id}`);

  await uploadImages(args.baseUrl, createdJob.id, imagePaths, args);
  console.log('[master-v1] images uploaded');

  await uploadMetadata(args.baseUrl, createdJob.id, args, imagePaths);
  console.log('[master-v1] metadata uploaded');

  await queueProcessing(args.baseUrl, createdJob.id, args);
  console.log('[master-v1] job queued');

  const finalJob = await pollUntilFinished(args.baseUrl, createdJob.id, args);

  console.log(`[master-v1] final status=${finalJob.status}`);
  if (finalJob.status === 'completed') {
    console.log(`[master-v1] optimizedGlbPath=${finalJob.outputs?.optimizedGlbPath || 'n/a'}`);
    console.log(`[master-v1] roomScanId=${finalJob.metadata?.roomScanId || finalJob.id}`);
    process.exit(0);
  }

  console.error(`[master-v1] failedStage=${finalJob.metadata?.failedStage || 'unknown'}`);
  console.error(`[master-v1] lastError=${finalJob.metadata?.lastError || 'unknown'}`);
  process.exit(1);
}

main().catch((error) => {
  console.error(`[master-v1] ${error.message}`);
  process.exit(1);
});