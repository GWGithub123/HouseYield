#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
  attachImagesToJob,
  attachMetadataToJob,
  createMasterJob,
  loadJob,
  queueMasterProcessing,
} from '../server/services/masterPipeline.js';

function parseArgs(argv) {
  const args = {
    imagesDir: path.join(process.cwd(), 'server', 'renovation', 'Test Bathroom 2'),
    pollIntervalMs: 30_000,
    timeoutMs: 3 * 60 * 60 * 1000,
    learnedMatchingPreset: 'roma_v2',
    learnedMatchingImageSize: 1024,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--images-dir') args.imagesDir = path.resolve(argv[++index] || args.imagesDir);
    else if (arg === '--poll-interval-ms') args.pollIntervalMs = Number(argv[++index] || args.pollIntervalMs);
    else if (arg === '--timeout-ms') args.timeoutMs = Number(argv[++index] || args.timeoutMs);
    else if (arg === '--learned-matching-preset') args.learnedMatchingPreset = argv[++index] || args.learnedMatchingPreset;
    else if (arg === '--learned-matching-image-size') args.learnedMatchingImageSize = Number(argv[++index] || args.learnedMatchingImageSize);
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/launch-metric3d-mesh-six-image-vm.mjs [--images-dir <dir>]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

const SUPPORTED = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif']);
const args = parseArgs(process.argv);
if (!process.env.MASTER_V1_GCP_WORKER_ENABLE) {
  process.env.MASTER_V1_GCP_WORKER_ENABLE = 'true';
}
if (!process.env.MASTER_V1_GCP_TRANSPORT) {
  process.env.MASTER_V1_GCP_TRANSPORT = 'gcloud';
}
const filenames = (await fs.readdir(args.imagesDir))
  .filter((name) => SUPPORTED.has(path.extname(name).toLowerCase()))
  .sort();

if (filenames.length === 0) {
  throw new Error(`no images in ${args.imagesDir}`);
}

const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const label = `6-image Metric3D mesh benchmark - ${timestamp}`;
const notes = [
  'Mesh-primary run: RoMA v2 + GLOMAP poses, Metric3D depth fusion, Poisson mesh, OpenMVS texturing.',
  'Ref-Gaussian and gaussian splatting are intentionally skipped.',
].join(' ');

const job = await createMasterJob({
  jobName: label,
  userId: 'local-smoke-test',
  metadata: {
    captureMode: 'room_tour',
    executionMode: 'master_mesh_primary_v1',
    canonicalSystem: true,
    roomName: label,
    userId: 'local-smoke-test',
    pipelineVersion: 'master_v1',
    benchmark: 'metric3d_mesh_only_6_image_mirror',
    notes,
    captureStats: { photoCount: filenames.length, clusterCount: 1 },
  },
});

await attachImagesToJob(
  job.id,
  filenames.map((name) => ({ path: path.join(args.imagesDir, name) })),
);
await attachMetadataToJob(job.id, {
  captureMode: 'room_tour',
  executionMode: 'master_mesh_primary_v1',
  canonicalSystem: true,
  roomName: label,
  userId: 'local-smoke-test',
  pipelineVersion: 'master_v1',
  benchmark: 'metric3d_mesh_only_6_image_mirror',
  notes,
  captureStats: { photoCount: filenames.length, clusterCount: 1 },
});

const options = {
  metric3dMeshOnly: true,
  primaryOutputIntent: 'textured_glb_mesh',
  learnedMatchingPreset: args.learnedMatchingPreset,
  learnedMatchingPresetExplicit: true,
  learnedMatchingImageSize: args.learnedMatchingImageSize,
  efficientLoftrRequired: false,
  requireGaussianSplatting: false,
  gaussianOnly: false,
  requireRefGaussian: false,
  refGaussianOnly: false,
  timeoutMs: args.timeoutMs,
};

console.log(`[mesh-six-image] created ${job.id} (${filenames.length} images) label="${label}"`);
console.log(`[mesh-six-image] imagesDir=${args.imagesDir}`);
console.log(`[mesh-six-image] queueing mesh-only (VM=${process.env.MASTER_V1_GCP_VM_NAME} zone=${process.env.MASTER_V1_GCP_VM_ZONE})`);
await queueMasterProcessing(job.id, options);

let lastStatusLine = '';
for (;;) {
  await new Promise((resolve) => setTimeout(resolve, args.pollIntervalMs));
  let current;
  try {
    current = await loadJob(job.id);
  } catch (error) {
    console.log(`[mesh-six-image] loadJob failed: ${error.message}`);
    continue;
  }
  const activeStages = (current.stages || [])
    .filter((stage) => stage && ['running', 'queued', 'failed'].includes(stage.status))
    .map((stage) => `${stage.id || stage.name}:${stage.status}`)
    .join(',');
  const statusLine = `status=${current.status} stages=[${activeStages}]`;
  if (statusLine !== lastStatusLine) {
    console.log(`[mesh-six-image] ${new Date().toISOString()} ${statusLine}`);
    lastStatusLine = statusLine;
  }
  if (current.status === 'completed' || current.status === 'failed') {
    console.log(`[mesh-six-image] FINAL ${current.status} jobId=${job.id}`);
    process.exit(current.status === 'completed' ? 0 : 1);
  }
}
